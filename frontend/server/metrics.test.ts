/* ------------------------------------------------------------------
 * Metrics 测试
 *
 * 指标最容易出的错不是算错，是**算出来没人能用**：
 * 成功率把限流算进去、P95 在样本少时给个离谱的数、
 * 或者环形缓冲写满后开始错位。这三种都在下面钉住。
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics';

describe('Metrics：成功率', () => {
  it('限流不计入成功率', () => {
    const m = new Metrics();
    m.record('ok', 100, 'llm');
    m.record('ok', 120, 'llm');
    m.record('failed', 200, 'llm');
    // 限流是我们主动挡的，不该拉低成功率
    m.record('limited', 1, 'rule');
    m.record('limited', 1, 'rule');

    const s = m.summary() as {
      chat: { ok: number; failed: number; limited: number; successRate: number | null };
    };
    expect(s.chat.ok).toBe(2);
    expect(s.chat.failed).toBe(1);
    expect(s.chat.limited).toBe(2);
    expect(s.chat.successRate).toBeCloseTo(0.667, 2);
  });

  it('没有完成样本时成功率为 null，而不是 0 或 100%', () => {
    const m = new Metrics();
    const s = m.summary() as { chat: { successRate: number | null; latencyMs: unknown } };
    // 0% 看起来像"全挂了"，100% 看起来像"全好"，两者都是误导
    expect(s.chat.successRate).toBeNull();
    expect(s.chat.latencyMs).toBeNull();
  });

  it('只有限流时成功率仍为 null', () => {
    const m = new Metrics();
    m.record('limited', 1, 'rule');
    const s = m.summary() as { chat: { successRate: number | null } };
    expect(s.chat.successRate).toBeNull();
  });
});

describe('Metrics：延迟', () => {
  it('p50 落在中位数上', () => {
    const m = new Metrics();
    for (const d of [10, 20, 30, 40, 50]) m.record('ok', d, 'llm');
    const s = m.summary() as { chat: { latencyMs: { p50: number; p95: number; max: number } } };
    expect(s.chat.latencyMs.p50).toBe(30);
    expect(s.chat.latencyMs.max).toBe(50);
  });

  it('p95 不超过最大值', () => {
    const m = new Metrics();
    for (let i = 1; i <= 100; i++) m.record('ok', i, 'llm');
    const s = m.summary() as { chat: { latencyMs: { p95: number; max: number } } };
    expect(s.chat.latencyMs.p95).toBeLessThanOrEqual(s.chat.latencyMs.max);
  });
});

describe('Metrics：环形缓冲', () => {
  it('超出容量后只保留最近 200 条，且窗口大小恒定', () => {
    const m = new Metrics();
    for (let i = 0; i < 250; i++) m.record(i % 2 === 0 ? 'ok' : 'failed', i, 'llm');

    const s = m.summary() as { window: { size: number }; chat: { ok: number; failed: number } };
    expect(s.window.size).toBe(200);
    expect(s.chat.ok + s.chat.failed).toBe(200);
    /*
     * 最近 200 条是 i=50..249（环形缓冲按时间覆盖最旧的）。
     * 其中偶数 100 个 → ok 100，奇数 100 个 → failed 100。
     *
     * 第一版这里写成了 25 —— 那是把"窗口里有多少条"和
     * "最近 50 条"搞混了。缓冲满了之后是整体滚动，不是只留尾部。
     */
    expect(s.chat.ok).toBe(100);
    expect(s.chat.failed).toBe(100);
  });

  it('计数器不受窗口影响（累计值）', () => {
    const m = new Metrics();
    for (let i = 0; i < 300; i++) m.record('ok', 1, 'llm');
    const s = m.summary() as { counters: Record<string, number> };
    expect(s.counters['chat.ok']).toBe(300);
  });
});

describe('Metrics：命名事件', () => {
  it('bump 累加', () => {
    const m = new Metrics();
    m.bump('degraded.llm_timeout');
    m.bump('degraded.llm_timeout');
    const s = m.summary() as { counters: Record<string, number> };
    expect(s.counters['degraded.llm_timeout']).toBe(2);
  });

  it('reset 清干净', () => {
    const m = new Metrics();
    m.record('ok', 1, 'llm');
    m.bump('x');
    m.reset();
    const s = m.summary() as { window: { size: number }; counters: Record<string, number> };
    expect(s.window.size).toBe(0);
    expect(Object.keys(s.counters)).toHaveLength(0);
  });
});
