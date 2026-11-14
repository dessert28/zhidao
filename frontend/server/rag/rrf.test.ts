/* ------------------------------------------------------------------
 * RRF 融合测试
 *
 * RRF 的价值全在"两路意见如何结合"上，所以测试重点：
 *   · 两路都靠前的文档必须排第一
 *   · 只被一路召回的文档不能被丢掉（这是与"取交集"的关键区别）
 *   · k 越大，排名差距的影响越小
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { RRF_K, fuseRrf, onlyInOneChannel } from './rrf';

const item = (docId: string, score = 1) => ({ docId, score });

describe('RRF 融合', () => {
  it('两路都排第一的文档胜出', () => {
    const fused = fuseRrf({
      bm25: [item('a'), item('b')],
      vector: [item('a'), item('c')],
    });
    expect(fused[0]!.docId).toBe('a');
    expect(fused[0]!.ranks).toEqual({ bm25: 1, vector: 1 });
  });

  it('只被一路召回的文档仍然保留（不取交集）', () => {
    const fused = fuseRrf({
      bm25: [item('a'), item('b')],
      vector: [item('c'), item('d')],
    });
    const ids = fused.map((f) => f.docId).sort();
    // 四个都在 —— 这是 RRF 与"两路都命中才算"的本质区别
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
    expect(onlyInOneChannel(fused)).toBe(4);
  });

  it('排名相加更靠前的文档胜出', () => {
    // a: 1+2, b: 2+1 → 同分；c: 3+3 更低
    const fused = fuseRrf({
      bm25: [item('a'), item('b'), item('c')],
      vector: [item('b'), item('a'), item('c')],
    });
    expect(fused[0]!.docId).toBe('a');
    expect(fused[1]!.docId).toBe('b');
    expect(fused[2]!.docId).toBe('c');
  });

  it('分数不参与融合，只看排名', () => {
    // bm25 给 a 打了 999 分，vector 把 b 排第一 —— 结果应由排名决定
    const fused = fuseRrf({
      bm25: [item('a', 999), item('b', 0.01)],
      vector: [item('b', 0.9), item('a', 0.1)],
    });
    // 两路各有一个第一，同分；顺序由插入顺序稳定决定，但都必须在前两位
    expect(fused.slice(0, 2).map((f) => f.docId).sort()).toEqual(['a', 'b']);
  });

  it('k 越大，排名的影响越平缓', () => {
    const lists = {
      bm25: [item('x'), item('y')],
      vector: [item('y'), item('x')],
    };
    const small = fuseRrf(lists, 1);
    const large = fuseRrf(lists, 1000);
    // 两种 k 下 x 与 y 都同分（互换了排名），所以都接近
    expect(Math.abs(small[0]!.rrfScore - small[1]!.rrfScore)).toBeLessThan(0.01);
    // k 大时绝对分值更小
    expect(large[0]!.rrfScore).toBeLessThan(small[0]!.rrfScore);
  });

  it('默认 k 是 60（docs/09 的约定）', () => {
    expect(RRF_K).toBe(60);
  });

  it('单路输入时按原顺序返回', () => {
    const fused = fuseRrf({ bm25: [item('a'), item('b'), item('c')] });
    expect(fused.map((f) => f.docId)).toEqual(['a', 'b', 'c']);
  });

  it('空输入不崩', () => {
    expect(fuseRrf({})).toEqual([]);
    expect(fuseRrf({ bm25: [], vector: [] })).toEqual([]);
  });

  it('同一路里重复的 docId 只计一次分', () => {
    const fused = fuseRrf({
      bm25: [item('a'), item('a'), item('b')],
      vector: [],
    });
    const a = fused.find((f) => f.docId === 'a')!;
    expect(a.ranks.bm25).toBe(1);
    // 分数只加了一次
    expect(a.rrfScore).toBeCloseTo(1 / (RRF_K + 1), 6);
  });
});
