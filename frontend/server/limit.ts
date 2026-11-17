/* ------------------------------------------------------------------
 * 限流与额度 —— 「不做就会真实亏钱」的那一个
 *
 * ============ 为什么它排在最前 ============
 *
 * 这个系统每轮对话都要调大模型。只要演示地址在外面可达，
 * 一个循环脚本几十秒就能把额度刷空 —— 而账单是真人付的。
 * docs/08 §6 早就写了「API 调用加限流」，但那一直只是一句话。
 *
 * 功能缺失最坏的结果是「不好用」；额度被刷空最坏的结果是
 * **演示当天服务直接停摆**。所以这个和功能进度无关，是上线前置条件。
 *
 * ============ 三层，各防一种情况 ============
 *
 * 1. **单 IP 速率限制**（滑动窗口）
 *    防一个人反复点、防脚本循环。默认 20 次/分钟。
 *
 * 2. **全局每日额度**
 *    防"多个 IP 一起刷"。单 IP 限流挡不住换 IP 的攻击，
 *    而每日总量是硬上限：到点就停，损失封顶。
 *
 * 3. **并发上限**
 *    防"一次开一百个窗口同时问"。模型调用是长连接（SSE），
 *    并发打满会把内存与上游配额一起拖垮。
 *
 * ============ 为什么写在内存里，不上 Redis ============
 *
 * 诚实地说：多实例部署时，内存计数会各算各的，额度需要乘实例数。
 * 但当前是单实例部署（docs/10 D6 明确不引 Redis）。
 * 与其为了"将来可能的分布式"引入一个现在用不上的依赖，
 * 不如把限制写清楚、把单实例这个前提也写清楚。
 * 真要多实例时，这个模块的接口不变，换实现即可。
 * ------------------------------------------------------------------ */

/** 一次判定的结果 */
export type LimitVerdict =
  | { ok: true; remaining: number }
  | { ok: false; reason: 'rate' | 'quota' | 'concurrency'; message: string; retryAfterSec: number };

interface Bucket {
  /** 这个窗口内已用的请求时间戳（毫秒），只保留最近 60 秒 */
  hits: number[];
}

export interface LimiterOptions {
  /** 每个 IP 每分钟允许的请求数 */
  perIpPerMinute?: number;
  /** 全局每日允许的请求数。0 表示不限 */
  dailyQuota?: number;
  /** 同时进行中的请求上限 */
  maxConcurrent?: number;
  /** 取当前时间，测试时可注入 */
  now?: () => number;
}

export class ChatLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perIpPerMinute: number;
  private readonly dailyQuota: number;
  private readonly maxConcurrent: number;
  private readonly now: () => number;

  /** 今天已用多少（跨天自动归零） */
  private usedToday = 0;
  private todayKey = '';

  /** 当前进行中 */
  private inflight = 0;

  constructor(opts: LimiterOptions = {}) {
    /*
     * 默认值不是随便定的：
     *   20 次/分钟 —— 一个人正常问诊不会超过这个，但脚本会被挡住
     *   500 次/天  —— 一场演示 + 评委试用，够；被刷也只会损失这么点
     *   8 并发     —— 单实例 Node 跑 SSE + 模型调用，再多就是自己压垮自己
     */
    this.perIpPerMinute = opts.perIpPerMinute ?? 20;
    this.dailyQuota = opts.dailyQuota ?? 500;
    this.maxConcurrent = opts.maxConcurrent ?? 8;
    this.now = opts.now ?? Date.now;
  }

  /**
   * 进入一次对话前的判定。
   *
   * <p>顺序刻意是「并发 → 额度 → 单 IP」：
   * 并发是全局状态，先看它最便宜；额度是硬上限，早点挡住能省一次计算；
   * 单 IP 需要按时间戳清理，放最后。
   */
  enter(ip: string): LimitVerdict {
    const now = this.now();

    // ---- 1. 并发 ----
    if (this.inflight >= this.maxConcurrent) {
      return {
        ok: false,
        reason: 'concurrency',
        message: '当前问诊人数较多，请稍后再试。',
        retryAfterSec: 5,
      };
    }

    // ---- 2. 每日额度 ----
    if (this.dailyQuota > 0) {
      const key = dayKey(now);
      if (key !== this.todayKey) {
        this.todayKey = key;
        this.usedToday = 0;
      }
      if (this.usedToday >= this.dailyQuota) {
        return {
          ok: false,
          reason: 'quota',
          message: '今日问诊服务次数已达上限，请明天再试，或直接到门诊导诊台咨询。',
          retryAfterSec: secondsUntilTomorrow(now),
        };
      }
    }

    // ---- 3. 单 IP 滑动窗口 ----
    const bucket = this.buckets.get(ip) ?? { hits: [] };
    const windowStart = now - 60_000;
    bucket.hits = bucket.hits.filter((t) => t > windowStart);

    if (bucket.hits.length >= this.perIpPerMinute) {
      this.buckets.set(ip, bucket);
      /*
       * 告诉调用方"最早那一次什么时候过期" —— 那才是真正能再试的时刻。
       * 固定回 60 秒是错的：用户可能在第 50 秒才触发限制，
       * 多等 50 秒毫无意义。
       */
      const oldest = bucket.hits[0] ?? now;
      return {
        ok: false,
        reason: 'rate',
        message: '问得太快了，稍等一下再继续。',
        retryAfterSec: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)),
      };
    }

    // 全部通过，才计入
    bucket.hits.push(now);
    this.buckets.set(ip, bucket);
    this.usedToday += 1;
    this.inflight += 1;

    /*
     * 顺手清理太旧的 IP 记录。
     * 不清的话 Map 会随访问 IP 数无界增长 —— 一个换 IP 的扫描器
     * 就能把内存吃满，那等于用另一种方式打挂了服务。
     */
    if (this.buckets.size > 5000) this.sweep(now);

    return {
      ok: true,
      remaining: Math.max(0, this.perIpPerMinute - bucket.hits.length),
    };
  }

  /** 请求结束（成功、失败、中断都必须调，否则并发数只增不减） */
  leave(): void {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  /** 当前状态，给健康检查与管理页看 */
  stats(): { inflight: number; usedToday: number; dailyQuota: number; ips: number } {
    return {
      inflight: this.inflight,
      usedToday: this.usedToday,
      dailyQuota: this.dailyQuota,
      ips: this.buckets.size,
    };
  }

  /** 清空窗口已过期的 IP，避免 Map 无界增长 */
  private sweep(now: number): void {
    const windowStart = now - 60_000;
    for (const [ip, b] of this.buckets) {
      const alive = b.hits.filter((t) => t > windowStart);
      if (alive.length === 0) this.buckets.delete(ip);
      else b.hits = alive;
    }
  }
}

function dayKey(ms: number): string {
  return new Date(ms).toLocaleDateString('sv-SE');
}

/** 距离明天零点还有多少秒。用本地时区 —— 额度按"患者那边的明天"算 */
function secondsUntilTomorrow(ms: number): number {
  const d = new Date(ms);
  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return Math.max(1, Math.ceil((tomorrow.getTime() - ms) / 1000));
}

/**
 * 从请求头取客户端 IP。
 *
 * <p>只信任 `x-forwarded-for` 的**第一段**：那是真实客户端。
 * 但反过来，这个头可以被伪造 —— 所以它只在部署在反向代理之后才有意义。
 * 部署说明里必须写清这一点：如果直接暴露 Node，任何人都能伪造 IP 绕过限流。
 */
export function clientIp(headers: Headers, fallback = 'unknown'): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = headers.get('x-real-ip');
  if (real) return real.trim();
  return fallback;
}
