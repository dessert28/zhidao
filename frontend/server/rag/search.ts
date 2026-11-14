/* ------------------------------------------------------------------
 * 混合检索：BM25 + 标签加权
 * 依据：docs/05 §4，docs/10 D2
 *
 * 关于 pgvector：
 *   生产版是「向量 + BM25 双路召回 + RRF(k=60) 融合」，
 *   见 docs/09 §5 的表设计。省赛版本没有 pgvector（要 Docker +
 *   PostgreSQL），所以这里先做**纯 BM25 单路**，接口形状保持一致：
 *   将来把 search() 换成 RRF 融合，Retrieval Agent 一行不用改。
 *
 * 关于中文分词：
 *   不引 jieba 这类分词库（体积大、省赛时间不够）。
 *   中文用**二元切分（bigram）**——把"空腹血糖"切成
 *   "空腹/腹血/血糖"，配合 BM25 的 IDF 权重，效果在短文本检索上
 *   足够好，而且零依赖、可单测。
 * ------------------------------------------------------------------ */

import { KB_DOCS, type KbDoc } from './kb';
// 只引类型：VectorHit 的实现在 vector-store.ts，
// 但那个模块会 import pg（原生依赖），不该被静态引入。
import type { VectorHit } from './vector-store';

/** BM25 参数。k1 控制词频饱和，b 控制长度归一化 */
const K1 = 1.5;
const B = 0.75;

/**
 * 中文 bigram 的虚词噪声过滤。
 *
 * 为什么需要：bigram 是免词典方案，代价是会产生大量无语义的组合。
 * 实测案例：「青霉素过敏能不能用」里 `不能` 这个 bigram 在
 * 「线上问诊能解决和不能解决的问题」标题中出现多次，词频压过了
 * 真正的核心词 `过敏`，导致召回排序错误。
 *
 * 判据：bigram 的**两个字都是虚词/助词**时丢弃。
 * 只丢一个不算 —— 「过敏」「血糖」这类实词组合必须保留。
 */
const FUNCTION_CHARS = new Set([
  '的', '了', '是', '在', '和', '与', '或', '也', '都', '就', '还',
  '很', '太', '更', '最', '不', '没', '有', '能', '会', '要', '想',
  '我', '你', '他', '她', '它', '们', '这', '那', '哪', '什', '么',
  '吗', '呢', '吧', '啊', '呀', '着', '过', '得', '地', '之', '其',
  '一', '个', '些', '点', '把', '被', '让', '给', '对', '从', '到',
]);

function isNoiseBigram(gram: string): boolean {
  return gram.length === 2 && FUNCTION_CHARS.has(gram[0]!) && FUNCTION_CHARS.has(gram[1]!);
}

/**
 * 中文 + 英文混合切分。
 *
 * 中文：连续汉字切成 bigram（单字串保留单字）
 * 英文/数字：按非字母数字切，转小写
 *
 * 为什么 bigram 而不是单字 + 词：
 *   单字召回率过高（"血"能匹配一切），词组又切不出来。
 *   bigram 是免词典方案里性价比最高的中间点。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // 连续汉字段
  const hanRuns = text.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const run of hanRuns) {
    if (run.length === 1) {
      if (!FUNCTION_CHARS.has(run)) tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      const gram = run.slice(i, i + 2);
      if (!isNoiseBigram(gram)) tokens.push(gram);
    }
  }
  // 英文/数字
  const latin = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  tokens.push(...latin);
  return tokens;
}

/** 预先算好的索引，模块加载时构建一次 */
interface IndexedDoc {
  doc: KbDoc;
  tokens: string[];
  /** 词 → 词频 */
  tf: Map<string, number>;
  len: number;
}

interface Index {
  docs: IndexedDoc[];
  df: Map<string, number>;
  avgLen: number;
  n: number;
}

function buildIndex(docs: KbDoc[]): Index {
  const indexed: IndexedDoc[] = docs.map((doc) => {
    // 标题权重高于正文：算 TF 时把标题重复 3 次
    const tokens = [
      ...tokenize(doc.title),
      ...tokenize(doc.title),
      ...tokenize(doc.title),
      ...tokenize(doc.content),
      ...doc.tags.flatMap((t) => [...tokenize(t), ...tokenize(t)]),
    ];
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { doc, tokens, tf, len: tokens.length };
  });

  const df = new Map<string, number>();
  for (const d of indexed) {
    for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const avgLen = indexed.reduce((s, d) => s + d.len, 0) / (indexed.length || 1);
  return { docs: indexed, df, avgLen, n: indexed.length };
}

let cachedIndex: Index | null = null;
function getIndex(): Index {
  cachedIndex ??= buildIndex(KB_DOCS);
  return cachedIndex;
}

export interface SearchHit {
  doc: KbDoc;
  /** 归一化到 0–1 的相关度，便于和 docs/05 的 0.75 阈值比较 */
  score: number;
  /** 命中的关键词，用于"为什么召回这条"的可解释性 */
  matchedTerms: string[];
}

/**
 * BM25 单查询打分。
 *
 * 返回按分数降序的前 limit 条。分数做 min-max 归一化到 0–1，
 * 因为 docs/05 §4 的证据充分性判据是「最高分 ≥ 0.75」，
 * 未归一化的 BM25 分数没有固定量纲，阈值无从谈起。
 */
export function search(query: string, limit = 5): SearchHit[] {
  const idx = getIndex();
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];

  const qSet = new Set(qTokens);
  const raw: Array<{ doc: KbDoc; score: number; matched: Set<string> }> = [];

  for (const d of idx.docs) {
    let score = 0;
    const matched = new Set<string>();

    for (const term of qSet) {
      const tf = d.tf.get(term);
      if (!tf) continue;
      const df = idx.df.get(term) ?? 0;
      // BM25 IDF，加 1 防止负值
      const idf = Math.log(1 + (idx.n - df + 0.5) / (df + 0.5));
      const norm = 1 - B + B * (d.len / idx.avgLen);
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
      matched.add(term);
    }

    if (score > 0) raw.push({ doc: d.doc, score, matched });
  }

  if (raw.length === 0) return [];

  raw.sort((a, b) => b.score - a.score);
  const top = raw.slice(0, limit);

  // min-max 归一化。只有一条时直接给 1 —— 它确实是当前最优
  const max = raw[0]?.score ?? 1;
  const min = raw[raw.length - 1]?.score ?? 0;
  const span = max - min;

  return top.map((r) => ({
    doc: r.doc,
    score: span > 1e-9 ? Number(((r.score - min) / span).toFixed(2)) : 1,
    matchedTerms: [...r.matched].slice(0, 6),
  }));
}

/**
 * 证据充分性判据 —— docs/05 §4 原文：
 *   「≥2 篇文档 且 最高分 ≥ 0.75」
 *
 * 归一化后最高分恒为 1，所以这个阈值实际过滤的是"是否只有 1 篇"。
 * 这是归一化的副作用，必须说清楚：
 *   真实系统里分数来自向量余弦相似度，有绝对量纲，0.75 才有意义。
 *   当前实现对阈值的解释是"召回数量足够"，而不是"相关度够高"。
 */
export function isEvidenceSufficient(hits: SearchHit[]): boolean {
  return hits.length >= 2 && (hits[0]?.score ?? 0) >= 0.75;
}

/** 知识库规模，用于健康检查与答辩时说明 */
export const KB_SIZE = KB_DOCS.length;

/* ============================ 混合检索（RRF） ============================ */

/**
 * 双路召回 + RRF 融合。
 *
 * <p><b>这是可选的增强路径</b>：pgvector 连不上时
 * {@link hybridSearch} 自动退回纯 BM25，行为与 {@link search} 完全一致。
 * 这样"clone 下来就能跑，不用装 Docker"那条承诺不会被破坏。
 *
 * <p>为什么值得做双路：
 *   · BM25 强在**精确词匹配**（"糖化血红蛋白"必须字面对上）
 *   · 向量强在**近义与共现**（"血糖高"能召回"空腹血糖偏高"）
 *   单路各有盲区，RRF 让两路的意见都参与而不需要分数可比。
 *
 * <p>诚实说明：向量层用的是哈希向量化（见 embed.ts），
 * 不是神经网络嵌入。它能覆盖 bigram 共现，但不懂真正的语义等价。
 * 换真模型时只改 embed()。
 */

/**
 * 向量路的相似度门槛。
 *
 * <p><b>为什么必须有这个门槛（实测出来的）：</b>
 * 哈希向量的绝对相似度普遍偏低（正确命中约 0.16，无关条目 0.02-0.05），
 * 而 RRF 只看排名不看分数 —— 于是"排第 3 的无关文档"也会被当成有效意见，
 * 把"腹泻补液""皮疹分诊"这类完全不相干的内容拉进结果。
 *
 * <p>实测：问"血糖高了要注意什么"，没有门槛时结果里混进了
 * "儿童发热""反复头晕""胸闷心慌"。加了 0.08 门槛后这些被挡在向量路之外，
 * 只有真正相关的条目才参与融合。
 *
 * <p>阈值取 0.08 而不是更高：哈希向量本身量纲就小，
 * 设太高会让向量路形同虚设（连正确命中都挡掉）。
 * 换真嵌入模型后这个阈值要重新标定 —— 新模型的相似度分布完全不同。
 */
const VECTOR_MIN_SIMILARITY = 0.08;

export async function hybridSearch(query: string, limit = 5): Promise<SearchHit[]> {
  // 单路 BM25 始终先跑：它是基线，也是降级路径
  const bm25 = search(query, Math.max(limit, 8));

  let vectorHits: VectorHit[] = [];
  try {
    // 动态 import：pg 与向量层只在开启时才加载
    const { isAvailable, searchVector } = await import('./vector-store.js');
    if (await isAvailable()) {
      vectorHits = (await searchVector(query, Math.max(limit, 8)))
        // 门槛：相似度不够的条目不该参与融合（见常量注释）
        .filter((h) => h.similarity >= VECTOR_MIN_SIMILARITY);
    }
  } catch {
    // 向量路挂了不影响主链路
    vectorHits = [];
  }

  // 没有向量结果 → 退化为纯 BM25（这就是默认路径）
  if (vectorHits.length === 0) return bm25.slice(0, limit);

  const { fuseRrf } = await import('./rrf.js');
  const fused = fuseRrf({
    bm25: bm25.map((h) => ({ docId: h.doc.docId, score: h.score })),
    vector: vectorHits.map((h) => ({ docId: h.doc.docId, score: h.similarity })),
  });

  // 融合后要回到 SearchHit 结构，供上层原样使用
  const byId = new Map<string, SearchHit>();
  for (const h of bm25) byId.set(h.doc.docId, h);
  for (const v of vectorHits) {
    if (!byId.has(v.doc.docId)) {
      byId.set(v.doc.docId, {
        doc: v.doc,
        // 只被向量召回的文档没有 BM25 分，用相似度作展示分
        score: Number(Math.max(0, v.similarity).toFixed(2)),
        matchedTerms: [],
      });
    }
  }

  return fused
    .slice(0, limit)
    .map((f) => byId.get(f.docId))
    .filter((h): h is SearchHit => Boolean(h));
}
