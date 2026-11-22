/* ------------------------------------------------------------------
 * 并行内核的测试
 *
 * 重点不在"结果对不对"（那个顺序跑也对），而在两件只有并发才会
 * 暴露的事：
 *   1. 两条链路是否**真的重叠执行** —— 串行也能得到一样的事件
 *   2. 两个缓冲区的**事件是否互不串** —— 串了就是线上"抢话"bug
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { collectParallel, type ParallelBranch } from './parallel.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('collectParallel', () => {
  it('两条链路真的并发：总耗时接近单条而不是两倍', async () => {
    const started: string[] = [];

    const branches: Array<ParallelBranch<string>> = [
      {
        key: 'a',
        run: async (sink) => {
          started.push('a');
          await sleep(120);
          sink('a-done');
          return 'ok';
        },
      },
      {
        key: 'b',
        run: async (sink) => {
          started.push('b');
          await sleep(120);
          sink('b-done');
          return 'ok';
        },
      },
    ];

    const t0 = Date.now();
    await collectParallel(branches);
    const elapsed = Date.now() - t0;

    // 两个都先启动，说明没有 await 完第一个才跑第二个
    expect(started).toContain('a');
    expect(started).toContain('b');
    // 串行至少 240ms；并发约 120ms。给足余量取 200ms
    expect(elapsed).toBeLessThan(200);
  });

  it('事件各自进自己的缓冲区，不互相污染', async () => {
    const branches: Array<ParallelBranch<string>> = [
      {
        key: 'triage',
        run: async (sink) => {
          sink('t1');
          await sleep(20);
          sink('t2');
          return 'ok';
        },
      },
      {
        key: 'retrieval',
        run: async (sink) => {
          sink('r1');
          await sleep(5);
          sink('r2');
          return 'ok';
        },
      },
    ];

    const { buffers } = await collectParallel(branches);

    expect(buffers.get('triage')).toEqual(['t1', 't2']);
    expect(buffers.get('retrieval')).toEqual(['r1', 'r2']);
  });

  it('返回与分支一一对应的结果，调用方可据此判断 blocked', async () => {
    const branches: Array<ParallelBranch<string>> = [
      { key: 'triage', run: async () => 'blocked' },
      { key: 'retrieval', run: async () => 'ok' },
    ];

    const { results } = await collectParallel(branches);

    expect(results).toEqual(['blocked', 'ok']);
    expect(results.includes('blocked')).toBe(true);
  });

  it('只传一条分支时也正常工作（单路退化）', async () => {
    const { buffers, results } = await collectParallel<string>([
      {
        key: 'triage',
        run: async (sink) => {
          sink('only');
          return 'ok';
        },
      },
    ]);

    expect(buffers.get('triage')).toEqual(['only']);
    expect(buffers.has('retrieval')).toBe(false);
    expect(results).toEqual(['ok']);
  });

  it('空分支列表：返回空缓冲与空结果，不抛异常', async () => {
    const { buffers, results } = await collectParallel<string>([]);
    expect(buffers.size).toBe(0);
    expect(results).toEqual([]);
  });

  it('任一分支抛错时向上抛，不静默吞掉', async () => {
    const branches: Array<ParallelBranch<string>> = [
      { key: 'a', run: async () => 'ok' },
      {
        key: 'b',
        run: async () => {
          throw new Error('boom');
        },
      },
    ];

    await expect(collectParallel(branches)).rejects.toThrow('boom');
  });
});
