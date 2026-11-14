/* ------------------------------------------------------------------
 * 本地向量化测试
 *
 * 这一层的性质必须测清楚，因为它容易被误认为"语义嵌入"：
 *   · 确定性：同文本 → 同向量（否则检索不可复现）
 *   · 归一化：L2 范数为 1（pgvector 余弦距离的前提）
 *   · 相关性：字面相近的文本相似度更高
 *   · 边界：空文本返回零向量，不产生 NaN
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { EMBED_DIM, cosine, embed, features, toPgVector } from './embed';

describe('特征切分', () => {
  it('中文切成 bigram', () => {
    expect(features('血糖')).toContain('血糖');
    expect(features('空腹血糖')).toEqual(expect.arrayContaining(['空腹', '腹血', '血糖']));
  });

  it('单字保留（防单字查询召回不到）', () => {
    expect(features('血')).toEqual(['血']);
  });

  it('英文与数字成词，统一小写', () => {
    expect(features('HbA1c 7.8')).toEqual(expect.arrayContaining(['hba1c', '7', '8']));
  });

  it('空文本返回空特征', () => {
    expect(features('')).toEqual([]);
    expect(features('   ')).toEqual([]);
  });
});

describe('向量化', () => {
  it('维度固定', () => {
    expect(embed('血糖')).toHaveLength(EMBED_DIM);
  });

  it('确定性：同文本两次得到相同向量', () => {
    const a = embed('空腹血糖偏高怎么办');
    const b = embed('空腹血糖偏高怎么办');
    expect(a).toEqual(b);
  });

  it('L2 归一化：自相似度为 1', () => {
    const v = embed('空腹血糖偏高');
    expect(cosine(v, v)).toBeCloseTo(1, 5);
  });

  it('空文本返回零向量而不是 NaN', () => {
    const v = embed('');
    expect(v.every((x) => x === 0)).toBe(true);
    // 零向量与自己的余弦为 0（不是 1），调用方要知道这一点
    expect(cosine(v, v)).toBe(0);
  });

  it('字面相近的文本相似度更高', () => {
    const q = embed('空腹血糖偏高');
    const near = embed('空腹血糖偏高要注意什么');
    const far = embed('儿童发热什么时候去医院');
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
  });

  it('共享 bigram 的文本有正相似度', () => {
    const a = embed('血糖偏高');
    const b = embed('血糖控制');
    expect(cosine(a, b)).toBeGreaterThan(0);
  });

  it('完全无关的文本相似度接近 0 或为负', () => {
    const a = embed('血糖');
    const b = embed('abcxyz');
    expect(Math.abs(cosine(a, b))).toBeLessThan(0.3);
  });
});

describe('pgvector 字面量', () => {
  it('输出 [x,y,...] 格式且元素为定点小数', () => {
    const s = toPgVector(embed('血糖'));
    expect(s.startsWith('[')).toBe(true);
    expect(s.endsWith(']')).toBe(true);
    const parts = s.slice(1, -1).split(',');
    expect(parts).toHaveLength(EMBED_DIM);
    // 不能出现科学计数法 —— pgvector 不接受
    expect(s).not.toMatch(/e[-+]/i);
  });
});
