/* ------------------------------------------------------------------
 * Retrieval Agent —— Agentic RAG 自纠循环
 * 依据：docs/05-Agent契约表.md §4
 *
 * 流程（对应 §4 的五步）：
 *   ① hybrid_search 召回 Top-N
 *   ② 证据充分性判定：≥2 篇 且 最高分 ≥0.75
 *   ③ 不充分 → expand_query 改写查询重试（最多 2 轮）
 *   ④ 生成严格约束在证据内
 *   ⑤ 逐句接地检查，删掉无法溯源的句子
 *
 * 关于本轮实现到什么程度（诚实说明）：
 *   - ① ② ④ ⑤ 是真实实现的
 *   - ③ 的 expand_query 当前是规则改写（同义词扩展），不是 LLM
 *   - ④ 的"生成"当前是**抽取式**（从证据里摘句子），不是生成式
 *
 * 为什么 ④ 用抽取而不是生成：
 *   在知识库只有 10 条、且没有接真实 LLM 的情况下，
 *   让模型"生成"必然引入幻觉，反而破坏接地性。
 *   抽取式的好处是**每一句都能溯源到具体 docId**，
 *   这正是接地检查要保证的性质。
 *   接上 LLM 后（M2），这里换成生成 + 生成后验证，接口不变。
 * ------------------------------------------------------------------ */

import type {
  AgentInput,
  AgentOutput,
  EvidenceRef,
  RetrievalPayload,
  Source,
} from '@shared/types/contract';
import type { AgentEvent } from '@shared/types/events';
import { emptyOutput, safeRun } from './safe-run.js';
import { isEvidenceSufficient, search, type SearchHit } from '../rag/search.js';

export const RETRIEVAL_TIMEOUT_MS = 8000;
/** docs/05 §4：expand_query 最多 2 轮 */
export const MAX_EXPAND_ROUNDS = 2;
/** docs/05 §4：证据充分性阈值 */
export const EVIDENCE_TOP_SCORE = 0.75;
export const EVIDENCE_MIN_DOCS = 2;

/* ============================ 查询改写 ============================ */

/**
 * 同义词/口语 → 医学表达的映射表。
 *
 * 这不是"智能"，是**确定的领域词表**。
 * 好处是可解释、可单测、零延迟；坏处是覆盖有限。
 * 接 LLM 之后这层保留作为"必过的一跳"——
 * 因为 LLM 改写可能把"血压"改没了，规则改写不会。
 */
const SYNONYMS: Array<[RegExp, string]> = [
  [/血糖|糖尿/g, '血糖 空腹血糖'],
  [/血压|高压|低压/g, '血压 血压偏高'],
  [/头晕|眩晕|晕/g, '头晕 眩晕'],
  [/肚子|腹部|胃不舒|胃疼|胃痛/g, '腹痛 上腹部疼痛'],
  [/咳嗽|咳/g, '咳嗽 咳痰'],
  [/过敏/g, '过敏 过敏史 药物过敏'],
  [/检查|化验|报告/g, '检查 化验 重复检查'],
  [/挂号|就诊|看病|准备/g, '就诊准备 材料'],
  [/复诊|随访|复查/g, '复诊 慢性病'],
];

/**
 * 第一次不充分时，把查询扩展一次。
 * 只做一轮：加同义词。第二轮不再扩，避免把查询改得越来越远。
 */
export function expandQuery(raw: string, round: number): string {
  if (round >= MAX_EXPAND_ROUNDS) return raw;
  let out = raw;
  for (const [pattern, replacement] of SYNONYMS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/* ============================ 抽取式作答 ============================ */

/**
 * 从证据里挑出与问题最相关的句子。
 *
 * 为什么按句子挑而不是整段贴：
 *   整段贴出来会有大量与用户问题无关的内容（比如用户问血糖，
 *   贴出"就诊前带一周记录"这半句就够，不需要整条）。
 *   逐句挑选也让接地检查有粒度。
 *
 * 关键约束：**句子必须在自己的文档里也有命中词**。
 * 曾经出现过的事故：问血糖时答案里混进「带上血压记录」，
 * 因为「偏高」这个词在血压条目里也命中，低分文档因此贡献了句子。
 * 判定句子相关性时只用**本文档自己的命中词**，跨文档不算。
 */
function pickSentences(hit: SearchHit, maxSentences = 2): string[] {
  const sentences = hit.doc.content
    .split(/[。；]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);

  if (sentences.length === 0) return [];

  const terms = hit.matchedTerms;
  const scored = sentences.map((s) => {
    const hitCount = terms.filter((t) => s.includes(t)).length;
    // 含就诊指引的句子加分，因为用户要的是"怎么做"
    const actionBonus = /(建议|需要|应|可以|带上|记录|告知|就诊)/.test(s) ? 1 : 0;
    return { s, score: hitCount * 2 + actionBonus, hitCount };
  });

  // 没有任何命中词的句子直接丢弃 —— 它和这个问题无关，
  // 哪怕它带了"建议"这种指引词。串味的根源就在这里。
  const relevant = scored.filter((x) => x.hitCount > 0);
  if (relevant.length === 0) return [];

  relevant.sort((a, b) => b.score - a.score);
  return relevant.slice(0, maxSentences).map((x) => x.s);
}

/**
 * 组织答案。
 *
 * 硬约束：**只用传进来的句子**，不添加任何知识库之外的内容。
 * 这是接地性（groundedness）的实现方式 —— 不是"尽量不编"，而是
 * 物理上不可能编（answer 完全由 picked 拼接而成）。
 */
function composeAnswer(picked: Array<{ text: string; docId: string }>): string {
  if (picked.length === 0) return '';
  return picked.map((p) => p.text).join('。') + '。';
}

/* ============================ 接地检查 ============================ */

/**
 * 逐句接地检查（docs/05 §4 第 ⑤ 步）。
 *
 * 判据：这句话里的关键词能在证据片段里找到，就算有依据。
 * 找不到的句子**删除**，并在返回里报告删了几句。
 *
 * 真实实现会是 embedding 相似度或 NLI，但逻辑一致：
 * 有依据才保留。规则版的价值是零延迟且判定可复现。
 */
export function groundingCheck(
  answer: string,
  sources: Source[],
): { answer: string; removed: number } {
  const sentences = answer.split('。').filter((s) => s.trim().length > 0);
  const corpus = sources.map((s) => s.snippet).join('');

  const kept: string[] = [];
  let removed = 0;

  for (const s of sentences) {
    // 从句子中取 2 字滑窗，看有多少能在证据里找到
    const grams: string[] = [];
    for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
    if (grams.length === 0) {
      kept.push(s);
      continue;
    }
    const found = grams.filter((g) => corpus.includes(g)).length;
    // 超过 50% 的 bigram 能在证据里找到，认为这句有依据
    if (found / grams.length >= 0.5) {
      kept.push(s);
    } else {
      removed++;
    }
  }

  return { answer: kept.join('。'), removed };
}

/* ============================ Agent ============================ */

export interface RetrievalInputPayload {
  text: string;
}

export interface RetrievalDeps {
  /** 可选的 LLM 改写（M2 接入）。失败时退回规则改写 */
  rewrite?(query: string, round: number): Promise<string | null>;
}

export function makeRetrieval(deps: RetrievalDeps = {}) {
  const handle = async (
    input: AgentInput<RetrievalInputPayload>,
  ): Promise<AgentOutput<RetrievalPayload>> => {
    const events: AgentEvent[] = [];
    const refinedQueries: string[] = [];
    let query = input.payload.text;

    /* ---- 第 ①② 步：检索 + 充分性判定 ---- */
    let hits = search(query, 5);
    let roundsUsed = 0;

    /* ---- 第 ③ 步：自纠循环 ---- */
    while (!isEvidenceSufficient(hits) && roundsUsed < MAX_EXPAND_ROUNDS) {
      roundsUsed++;

      let next: string | null = null;
      if (deps.rewrite) {
        try {
          next = await deps.rewrite(query, roundsUsed);
        } catch {
          next = null; // LLM 改写失败 → 规则改写
        }
      }
      const expanded = next ?? expandQuery(query, roundsUsed);

      if (expanded === query) break; // 改不动了，再试也没意义
      query = expanded;
      refinedQueries.push(query);

      events.push({
        type: 'retry',
        reason: '证据不足，已扩展检索词',
        from: 'retrieval',
        to: 'retrieval',
        round: roundsUsed,
      });

      hits = search(query, 5);
    }

    const sources: Source[] = hits.map((h) => ({
      docId: h.doc.docId,
      title: h.doc.title,
      snippet: h.doc.content.slice(0, 120),
      score: h.score,
    }));

    const lowEvidence = !isEvidenceSufficient(hits);

    /* ---- 无证据：直接如实说，不硬编 ---- */
    if (hits.length === 0) {
      return {
        status: 'failed',
        payload: {
          answer: '知识库里没有检索到与这个问题直接相关的资料。',
          sources: [],
          roundsUsed,
          refinedQueries,
          lowEvidence: true,
        },
        confidence: 0,
        evidence: [],
        events: [
          ...events,
          {
            type: 'caveat',
            text: '未检索到相关资料，无法给出有依据的回答。建议咨询医生或到门诊导诊台询问。',
          },
        ],
      };
    }

    /* ---- 第 ④ 步：抽取式作答（只用证据里的句子） ---- */
    const picked: Array<{ text: string; docId: string }> = [];
    for (const h of hits.slice(0, 2)) {
      for (const s of pickSentences(h, 2)) {
        picked.push({ text: s, docId: h.doc.docId });
      }
    }

    let answer = composeAnswer(picked);

    /* ---- 第 ⑤ 步：接地检查 ---- */
    const grounded = groundingCheck(answer, sources);
    answer = grounded.answer ? `${grounded.answer}。` : answer;

    if (grounded.removed > 0) {
      events.push({
        type: 'caveat',
        text: `已删除 ${grounded.removed} 句缺乏资料依据的内容。`,
      });
    }

    /* ---- 证据不足时诚实标注 ---- */
    if (lowEvidence) {
      events.push({
        type: 'caveat',
        text: '本问题检索到的资料较少，以上内容仅供参考，建议以医生意见为准。',
      });
    }

    /* ---- 引用事件：把来源推给前端渲染 ---- */
    // 复用 tool_result 承载来源列表 —— 契约的 14 类事件里没有独立的
    // sources 事件，而 tool_result 的语义正是"工具返回了什么"，
    // 检索结果天然属于这一类。前端按 name 区分渲染。
    events.push({
      type: 'tool_result',
      name: 'hybrid_search',
      ok: true,
      result: { count: sources.length, sources },
    });

    /*
     * EvidenceRef 的形状是 { type, id, span }，其中 span 是字符区间。
     * 检索层拿到的是整篇文档，没有句级偏移，所以这里给整篇的范围
     * [0, content.length] —— 标注为粗粒度溯源，而不是假装精确。
     */
    const evidence: EvidenceRef[] = hits.map((h) => ({
      type: 'doc',
      id: h.doc.docId,
      span: [0, h.doc.content.length] as [number, number],
    }));

    // 置信度：证据越充分越高，但不超过 0.85 —— 检索结果不该显得比医生权威
    const confidence = lowEvidence ? 0.45 : Math.min(0.85, 0.6 + hits.length * 0.05);

    return {
      status: 'ok',
      payload: { answer, sources, roundsUsed, refinedQueries, lowEvidence },
      confidence: Number(confidence.toFixed(2)),
      evidence,
      events,
    };
  };

  return (input: AgentInput<RetrievalInputPayload>) =>
    safeRun(handle, input, {
      agent: 'retrieval',
      timeoutMs: RETRIEVAL_TIMEOUT_MS,
      fallback: emptyOutput<RetrievalPayload>({
        answer: '',
        sources: [],
        roundsUsed: 0,
        refinedQueries: [],
        lowEvidence: true,
      }),
    });
}
