/* ------------------------------------------------------------------
 * 本地向量化 —— 无需外部模型的确定性嵌入
 *
 * ============ 为什么不用真嵌入模型 ============
 *
 * 试过三条路，都不通（实测）：
 *   Xenova/bge-small-zh-v1.5              只有 tokenizer，无 onnx 权重
 *   Xenova/paraphrase-multilingual-MiniLM 同上
 *   Xenova/all-MiniLM-L6-v2               同上
 * ModelScope 上这几个仓库都没有导出 onnx，任选一个下载都会在加载时失败。
 *
 * ============ 那用什么 ============
 *
 * **哈希向量化（hashing vectorizer）+ 中文 bigram**：
 *   · 确定性：同样的文本永远得到同样的向量
 *   · 零依赖：不需要模型权重、不需要网络
 *   · 可测：向量空间的行为可以写断言验证
 *
 * 它**不是语义嵌入** —— 不懂同义改写（"血糖高" vs "高血糖" 能对上，
 * 但 "血糖" vs "葡萄糖" 对不上）。这一点必须说清楚，
 * 否则会有人以为我们真的做了语义检索。
 *
 * ============ 那它有什么价值 ============
 *
 * 1. **把 pgvector 与 RRF 这条链路真正跑通并验证**。
 *    换真模型时只改 embed() 一个函数，其余不动。
 * 2. 哈希向量在中英混合的短文本上，配合 BM25 的双路召回
 *    确实比单路 BM25 更稳（同义词覆盖靠 bigram，精确匹配靠 BM25）。
 *
 * 换句话说：**这一层是基础设施验证，不是语义能力的假装**。
 * 答辩时被问"你们的向量检索是语义的吗"，
 * 答案是"向量层用哈希，架构已支持换真模型；
 * 当前的语义能力主要来自 bigram 共现，不是神经网络"。
 * ------------------------------------------------------------------ */

/** 向量维度。512 维在 20 条知识库上足够，且落库体积小 */
export const EMBED_DIM = 512;

/**
 * 中文 bigram + 英文词 → 特征桶。
 *
 * <p>hash 用 FNV-1a：实现简单、分布均匀、无依赖。
 * 不要用 `str.length` 之类做桶号 —— 那会导致大量碰撞。
 */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 乘 16777619，用位移避免溢出成负数
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

/** 把文本切成特征：中文 bigram + 单个汉字（防单字查询）+ 英文/数字词 */
export function features(text: string): string[] {
  const out: string[] = [];
  const normalized = text.toLowerCase();

  // 中文段：bigram
  for (const run of normalized.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      out.push(run.slice(i, i + 2));
    }
  }

  // 英文与数字
  for (const w of normalized.match(/[a-z0-9]+/g) ?? []) {
    out.push(w);
  }

  return out;
}

/**
 * 文本 → 归一化向量。
 *
 * <p>用**带符号哈希**（同一特征固定落到某个桶，符号也固定）：
 * 纯计数哈希在大文本上会把桶和得很平均，反而失去区分度；
 * 带符号让不同特征的贡献可以相消，保留方向信息。
 *
 * <p>最后做 L2 归一化 —— pgvector 的余弦距离要求单位向量，
 * 否则长度会污染相似度。
 */
export function embed(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);

  for (const f of features(text)) {
    const h = fnv1a(f);
    const idx = h % EMBED_DIM;
    // 用 hash 的高位决定符号，让不同特征能相消
    const sign = (h & 0x80000000) !== 0 ? 1 : -1;
    v[idx]! += sign;
  }

  // L2 归一化
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v; // 空文本返回零向量，由调用方处理

  return v.map((x) => x / norm);
}

/** 余弦相似度（向量已归一化，等价于点积） */
export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** 转成 pgvector 的字面量格式：[0.1,0.2,...] */
export function toPgVector(v: number[]): string {
  return `[${v.map((x) => x.toFixed(6)).join(',')}]`;
}
