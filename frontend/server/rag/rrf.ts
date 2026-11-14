/* ------------------------------------------------------------------
 * RRF（Reciprocal Rank Fusion）融合
 * 依据：docs/09 §5「向量 + BM25 双路召回 + RRF(k=60) 融合」
 *
 * ============ 为什么用 RRF 而不是加权平均分数 ============
 *
 * BM25 的分数是无量纲的（归一化到 0-1 是我们自己做的），
 * 向量余弦是 -1~1 的相似度。两者**不可比** ——
 * 直接把 0.7×BM25 + 0.3×余弦 相加，等于假设两把尺子的刻度一致，
 * 而这个假设没有任何依据。
 *
 * RRF 只看**排名**不看分数：
 *     score(d) = Σ 1 / (k + rank_i(d))
 * 这样两路只要"都觉得某文档靠前"就能互相加强，
 * 而不会因为某一路的分数尺度更大就压倒另一路。
 *
 * k=60 是原论文的经验值：它让排名 1 和排名 2 的差距不至于过大，
 * 从而让两路的意见都能真正参与。
 * ------------------------------------------------------------------ */

/** RRF 的平滑常数。docs/09 用的是 60，跟论文一致 */
export const RRF_K = 60;

/** 一个候选文档及其在某一路里的排名（0-based） */
export interface RankedItem {
  docId: string;
  /** 该路的原始分数，仅用于展示与调试，不参与融合 */
  score: number;
}

export interface FusedItem {
  docId: string;
  /** 融合后的 RRF 分数 */
  rrfScore: number;
  /** 在各路里的排名（1-based），undefined 表示该路没召回 */
  ranks: Record<string, number>;
}

/**
 * 融合多路召回结果。
 *
 * @param lists 每路的结果，按该路的相关度降序
 * @param k     平滑常数
 * @returns 按 RRF 分数降序的融合列表
 */
export function fuseRrf(
  lists: Record<string, readonly RankedItem[]>,
  k = RRF_K,
): FusedItem[] {
  const acc = new Map<string, FusedItem>();

  for (const [channel, items] of Object.entries(lists)) {
    items.forEach((item, idx) => {
      const rank = idx + 1; // RRF 用 1-based 排名
      let entry = acc.get(item.docId);
      if (!entry) {
        entry = { docId: item.docId, rrfScore: 0, ranks: {} };
        acc.set(item.docId, entry);
      }
      // 同一路里重复出现只算一次（理论上不该发生，防御性处理）
      if (entry.ranks[channel] !== undefined) return;
      entry.ranks[channel] = rank;
      entry.rrfScore += 1 / (k + rank);
    });
  }

  return [...acc.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * 只有一路命中的文档要不要保留？
 *
 * <p>保留。这是 RRF 的关键性质：**两路都靠前的文档会胜出，
 * 但只被一路召回的文档仍然在结果里**。
 * 如果强行要求"两路都命中"，就等于用交集 ——
 * 那会把 BM25 独有的精确匹配和向量独有的近义匹配都丢掉一部分。
 */
export function onlyInOneChannel(fused: readonly FusedItem[]): number {
  return fused.filter((f) => Object.keys(f.ranks).length === 1).length;
}
