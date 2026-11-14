/* ------------------------------------------------------------------
 * pgvector 存储层 —— 知识库向量
 * 依据：docs/09 §5 的 kb_chunk 表设计
 *
 * ============ 这一层是可选的 ============
 *
 * 省赛默认走内存 BM25（零依赖、评委不用起 Docker）。
 * 这里实现了向量检索，但**连不上就不启用** ——
 * 由 `isAvailable()` 探测，Retrieval Agent 据此决定走单路还是双路。
 *
 * 这个设计是刻意的：README 承诺过「clone 下来就能跑，不用装 MySQL」，
 * 加一个"必须起 Docker 才能用"的硬依赖会毁掉那条承诺。
 *
 * ============ 为什么用 pg 的 SQL 而不是 ORM ============
 *
 * 这里只有一个查询和一个批量插入，而且要用到 pgvector 的
 * `<=>`（余弦距离）运算符 —— ORM 反而要多写一层映射。
 * 直接 SQL 也更好答辩：把查询贴出来就能讲清楚 RRF 之前的两路是怎么取的。
 * ------------------------------------------------------------------ */

import { EMBED_DIM, embed, toPgVector } from './embed';
import type { KbDoc } from './kb';
import { KB_DOCS } from './kb';

/** 连接串。与 docker-compose 的 PGVECTOR_* 对应 */
function connString(): string {
  return (
    process.env.PGVECTOR_URL ??
    `postgresql://${process.env.PGVECTOR_USER ?? 'zhidao'}:${
      process.env.PGVECTOR_PASSWORD ?? 'zhidao'
    }@localhost:${process.env.PGVECTOR_PORT ?? '5432'}/${process.env.PGVECTOR_DB ?? 'zhidao'}`
  );
}

/** 只有显式开启才尝试连接 —— 见文件头"可选"说明 */
function enabled(): boolean {
  return (process.env.PGVECTOR_ENABLED ?? '').toLowerCase() === 'true';
}

interface PgLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  end: () => Promise<void>;
}

let clientPromise: Promise<PgLike | null> | null = null;

async function getClient(): Promise<PgLike | null> {
  if (!enabled()) return null;

  clientPromise ??= (async () => {
    try {
      // 动态 import：pg 只在开启时才需要，不拖累默认路径
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: connString() });
      await client.connect();
      return client as unknown as PgLike;
    } catch {
      // 连不上就当没启用 —— 降级是默认行为
      return null;
    }
  })();

  return clientPromise;
}

/** 向量检索是否可用（连得上且表已建好） */
export async function isAvailable(): Promise<boolean> {
  const c = await getClient();
  if (!c) return false;
  try {
    await c.query('SELECT 1 FROM kb_chunk LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * 建表 + 灌入知识库向量。
 *
 * <p>幂等：表用 IF NOT EXISTS，行用 ON CONFLICT 覆盖。
 * 反复调用不会产生重复行 —— 否则每次启动都会把知识库叠一遍。
 */
export async function ensureSchema(): Promise<boolean> {
  const c = await getClient();
  if (!c) return false;

  try {
    await c.query('CREATE EXTENSION IF NOT EXISTS vector');
    await c.query(`
      CREATE TABLE IF NOT EXISTS kb_chunk (
        doc_id     TEXT PRIMARY KEY,
        source     TEXT NOT NULL,
        title      TEXT NOT NULL,
        content    TEXT NOT NULL,
        departments TEXT[] NOT NULL DEFAULT '{}',
        tags       TEXT[] NOT NULL DEFAULT '{}',
        embedding  vector(${EMBED_DIM}) NOT NULL
      )
    `);

    for (const doc of KB_DOCS) {
      const vec = toPgVector(embed(`${doc.title} ${doc.content} ${doc.tags.join(' ')}`));
      await c.query(
        `INSERT INTO kb_chunk (doc_id, source, title, content, departments, tags, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (doc_id) DO UPDATE
           SET title=$3, content=$4, departments=$5, tags=$6, embedding=$7`,
        [doc.docId, doc.source, doc.title, doc.content, doc.departments, doc.tags, vec],
      );
    }
    return true;
  } catch (err) {
    console.warn('[pgvector] 建表或灌数据失败:', err instanceof Error ? err.message : err);
    return false;
  }
}

export interface VectorHit {
  doc: KbDoc;
  /** 余弦相似度，-1~1，越大越像 */
  similarity: number;
}

/**
 * 向量召回 Top-N。
 *
 * <p>用 `<=>` 余弦距离（1 - 相似度），ORDER BY 升序即最相似。
 * 返回结构刻意与 BM25 的 `SearchHit` 对齐（doc + 分数），
 * 这样 RRF 融合时不用为两路写两套适配。
 */
export async function searchVector(query: string, limit = 8): Promise<VectorHit[]> {
  const c = await getClient();
  if (!c) return [];

  try {
    const vec = toPgVector(embed(query));
    const r = await c.query(
      `SELECT doc_id, source, title, content, departments, tags,
              1 - (embedding <=> $1) AS similarity
         FROM kb_chunk
        ORDER BY embedding <=> $1
        LIMIT $2`,
      [vec, limit],
    );

    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      doc: {
        docId: row.doc_id as string,
        source: row.source as string,
        title: row.title as string,
        content: row.content as string,
        departments: (row.departments as string[]) ?? [],
        tags: (row.tags as string[]) ?? [],
      },
      similarity: Number(row.similarity),
    }));
  } catch {
    return [];
  }
}

/** 供测试/运维：清空表 */
export async function reset(): Promise<void> {
  const c = await getClient();
  if (!c) return;
  await c.query('TRUNCATE kb_chunk').catch(() => undefined);
}
