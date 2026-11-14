/* ------------------------------------------------------------------
 * 混合检索集成测试（对真实 pgvector）
 *
 * 这组测试**只在 pgvector 可用时运行**（PGVECTOR_ENABLED=true）。
 * 未开启时整体跳过 —— 不能让"没装 Docker"变成测试失败，
 * 那样会逼着人为了跑测试去装环境，与"clone 下来就能跑"的承诺冲突。
 *
 * 测的是真链路：建表 → 灌向量 → SQL 检索 → RRF 融合。
 * 纯函数部分（embed / rrf）已经有各自的单元测试，这里只管集成。
 * ------------------------------------------------------------------ */

import { afterAll, describe, expect, it } from 'vitest';

const ENABLED = (process.env.PGVECTOR_ENABLED ?? '').toLowerCase() === 'true';

describe.skipIf(!ENABLED)('混合检索（真实 pgvector）', () => {
  afterAll(async () => {
    // 不断开连接会让 vitest 挂住（pg 的连接池有 keep-alive）
    try {
      const { reset } = await import('./vector-store');
      await reset();
    } catch {
      /* 忽略 */
    }
  });

  it('pgvector 可用且表已建好', async () => {
    const { ensureSchema, isAvailable } = await import('./vector-store');
    expect(await ensureSchema()).toBe(true);
    expect(await isAvailable()).toBe(true);
  });

  it('向量检索能返回语义相关的条目', async () => {
    const { searchVector } = await import('./vector-store');
    const hits = await searchVector('空腹血糖偏高', 3);
    expect(hits.length).toBeGreaterThan(0);
    // 第一条应该是血糖相关（哈希向量 + bigram 足够做到这点）
    expect(hits[0]!.doc.title).toContain('血糖');
    // 相似度是归一化向量的余弦，应在 0-1 之间
    expect(hits[0]!.similarity).toBeGreaterThan(0);
    expect(hits[0]!.similarity).toBeLessThanOrEqual(1);
  });

  it('混合检索在 pgvector 开启时仍是有效结果', async () => {
    const { hybridSearch } = await import('./search');
    const hits = await hybridSearch('感冒了要不要吃抗生素', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.doc.title).toContain('抗生素');
  });

  it('相似度门槛挡住无关条目（实测缺陷回归）', async () => {
    /*
     * 没有门槛时：问「血糖高了要注意什么」，RRF 会把
     * "儿童发热""腹泻补液"这类排名靠后但相似的文档也拉进来 ——
     * 因为 RRF 只看排名不看分数。
     * 加了 VECTOR_MIN_SIMILARITY 之后，这些被挡在向量路之外。
     */
    const { hybridSearch } = await import('./search');
    const hits = await hybridSearch('血糖高了要注意什么', 5);
    const titles = hits.map((h) => h.doc.title).join(' ');
    // 不该出现完全无关的场景
    expect(titles).not.toContain('皮疹');
    expect(titles).not.toContain('腹泻');
    // 但必须包含正确答案
    expect(titles).toContain('血糖');
  });

  it('结果数量不超过 limit', async () => {
    const { hybridSearch } = await import('./search');
    const hits = await hybridSearch('头晕', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});

describe.skipIf(ENABLED)('混合检索（未开启 pgvector 时应降级）', () => {
  it('hybridSearch 退回纯 BM25，结果与 search 一致', async () => {
    const { hybridSearch, search } = await import('./search');
    const q = '空腹血糖偏高';
    const bm25 = search(q, 5);
    const hybrid = await hybridSearch(q, 5);
    expect(hybrid.map((h) => h.doc.docId)).toEqual(bm25.map((h) => h.doc.docId));
  });
});
