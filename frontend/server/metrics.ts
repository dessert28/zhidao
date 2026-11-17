/* ------------------------------------------------------------------
 * 指标 —— 「出问题时能说清发生了什么」
 *
 * ============ 为什么这个比日志重要 ============
 *
 * 日志是"按时间顺序的记录"，回答不了"过去一小时有多少次对话失败"。
 * 演示当天一旦变慢或报错，需要的是一眼看懂的几个数：
 * 成功率、P95 耗时、限流挡了多少、模型降级了几次。
 *
 * ============ 为什么自己写而不是引 OpenTelemetry ============
 *
 * 单实例、单进程、进程重启即清零 —— 这三点决定了完整可观测栈
 * 现在带来的是复杂度而不是信息。这里只做"进程内环形统计"，
 * 外加一个 /api/metrics 端点。真要接 Prometheus 时，
 * 这个模块的计数器换成 micrometer 即可，调用方不用改。
 *
 * 计数器的内存上界是固定的（环形缓冲区 + 固定键），
 * 不会因为访问量增长而涨 —— 这很重要，监控自己不能成为内存泄漏源。
 * ------------------------------------------------------------------ */

/** 一次请求的结局 */
export type Outcome = 'ok' | 'failed' | 'limited' | 'aborted';

interface Sample {
  at: number;
  durationMs: number;
  outcome: Outcome;
  /** 走的是模型还是规则路由 */
  mode: 'llm' | 'rule';
}

const RING_SIZE = 200;

/**
 * 指标收集器。
 *
 * <p>刻意做成类而不是模块级单例：
 * 测试里需要每个用例一份干净的实例，
 * 否则用例之间会互相污染（第一个用例的失败数会出现在第二个里）。
 */
export class Metrics {
  private readonly ring: Sample[] = [];
  private cursor = 0;
  private readonly counters = new Map<string, number>();
  private readonly startedAt = Date.now();

  /** 记一次对话 */
  record(outcome: Outcome, durationMs: number, mode: 'llm' | 'rule'): void {
    const sample: Sample = { at: Date.now(), durationMs, outcome, mode };
    if (this.ring.length < RING_SIZE) this.ring.push(sample);
    else {
      this.ring[this.cursor] = sample;
      this.cursor = (this.cursor + 1) % RING_SIZE;
    }
    this.bump(`chat.${outcome}`);
    this.bump(`chat.mode.${mode}`);
  }

  /** 记一次命名事件（降级、限流原因、上游错误类型等） */
  bump(key: string, n = 1): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + n);
  }

  /**
   * 汇总。
   *
   * <p>成功率按"ok / (ok + failed)"算，**不含限流**：
   * 限流是我们主动挡的，算进成功率会让指标看起来变差，
   * 但那恰恰是系统在正常工作。混在一起就失去了诊断价值。
   */
  summary(): Record<string, unknown> {
    const n = this.ring.length;
    const ok = this.ring.filter((s) => s.outcome === 'ok').length;
    const failed = this.ring.filter((s) => s.outcome === 'failed').length;
    const limited = this.ring.filter((s) => s.outcome === 'limited').length;

    const durations = this.ring.map((s) => s.durationMs).sort((a, b) => a - b);
    const pct = (p: number) => {
      if (durations.length === 0) return 0;
      const idx = Math.min(durations.length - 1, Math.floor((p / 100) * durations.length));
      return durations[idx] ?? 0;
    };

    const completed = ok + failed;

    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      window: {
        size: n,
        note: `最近 ${RING_SIZE} 次对话的滚动窗口`,
      },
      chat: {
        ok,
        failed,
        limited,
        successRate: completed === 0 ? null : Number((ok / completed).toFixed(3)),
        latencyMs: n === 0 ? null : { p50: pct(50), p95: pct(95), max: durations.at(-1) ?? 0 },
      },
      counters: Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b))),
    };
  }

  /** 测试用 */
  reset(): void {
    this.ring.length = 0;
    this.cursor = 0;
    this.counters.clear();
  }
}
