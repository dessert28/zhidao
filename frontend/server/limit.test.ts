/* ------------------------------------------------------------------
 * 限流测试 —— 这类"保护性代码"最容易写错且没人发现
 *
 * 它平时不出现，只在出问题时才生效。出问题时如果它本身是错的，
 * 表现是"服务看起来正常，但其实一点保护都没有"，比不写更危险。
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { ChatLimiter, clientIp } from './limit';

/** 可控时钟：不用真的等 60 秒 */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

describe('ChatLimiter：单 IP 速率', () => {
  it('窗口内超出次数被拒', () => {
    const c = clock();
    const l = new ChatLimiter({ perIpPerMinute: 3, dailyQuota: 0, now: c.now });

    expect(l.enter('1.1.1.1').ok).toBe(true);
    expect(l.enter('1.1.1.1').ok).toBe(true);
    expect(l.enter('1.1.1.1').ok).toBe(true);

    const fourth = l.enter('1.1.1.1');
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.reason).toBe('rate');
  });

  it('窗口滑过去之后恢复', () => {
    const c = clock();
    const l = new ChatLimiter({ perIpPerMinute: 1, dailyQuota: 0, now: c.now });

    expect(l.enter('a').ok).toBe(true);
    expect(l.enter('a').ok).toBe(false);
    c.advance(61_000);
    expect(l.enter('a').ok).toBe(true);
  });

  it('retryAfter 指向最早一次过期，而不是固定 60 秒', () => {
    const c = clock();
    const l = new ChatLimiter({ perIpPerMinute: 1, dailyQuota: 0, now: c.now });
    l.enter('a');
    c.advance(50_000);

    const v = l.enter('a');
    expect(v.ok).toBe(false);
    /*
     * 已经过了 50 秒，只该再等约 10 秒。
     * 回 60 秒会让用户多等 50 秒，而且他会觉得"等了还是不行"。
     */
    if (!v.ok) expect(v.retryAfterSec).toBeLessThanOrEqual(11);
  });

  it('不同 IP 互不影响', () => {
    const c = clock();
    const l = new ChatLimiter({ perIpPerMinute: 1, dailyQuota: 0, now: c.now });
    expect(l.enter('a').ok).toBe(true);
    expect(l.enter('b').ok).toBe(true);
  });
});

describe('ChatLimiter：每日额度', () => {
  it('到上限后拒绝，且原因与速率不同', () => {
    const c = clock();
    const l = new ChatLimiter({ perIpPerMinute: 100, dailyQuota: 2, now: c.now });

    expect(l.enter('a').ok).toBe(true);
    expect(l.enter('b').ok).toBe(true);

    const v = l.enter('c');
    expect(v.ok).toBe(false);
    // 换 IP 也挡得住 —— 这正是额度存在的理由
    if (!v.ok) expect(v.reason).toBe('quota');
  });

  it('跨天后额度重置', () => {
    const c = clock();
    const l = new ChatLimiter({ perIpPerMinute: 100, dailyQuota: 1, now: c.now });
    expect(l.enter('a').ok).toBe(true);
    expect(l.enter('b').ok).toBe(false);

    c.advance(24 * 3600_000);
    expect(l.enter('c').ok).toBe(true);
  });

  it('额度为 0 表示不限', () => {
    const c = clock();
    const l = new ChatLimiter({ perIpPerMinute: 100, dailyQuota: 0, maxConcurrent: 100, now: c.now });
    for (let i = 0; i < 20; i++) expect(l.enter('x' + i).ok).toBe(true);
  });
});

describe('ChatLimiter：并发', () => {
  it('超过并发上限被拒，释放后恢复', () => {
    const c = clock();
    const l = new ChatLimiter({ perIpPerMinute: 100, dailyQuota: 0, maxConcurrent: 2, now: c.now });

    expect(l.enter('a').ok).toBe(true);
    expect(l.enter('b').ok).toBe(true);

    const third = l.enter('c');
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toBe('concurrency');

    l.leave();
    expect(l.enter('d').ok).toBe(true);
  });

  it('leave 不会被多调成负数', () => {
    const c = clock();
    const l = new ChatLimiter({ perIpPerMinute: 100, dailyQuota: 0, maxConcurrent: 1, now: c.now });
    l.leave();
    l.leave();
    // 并发已经在 0，不该被算成"负数从而放开更多"
    expect(l.stats().inflight).toBe(0);
    expect(l.enter('a').ok).toBe(true);
  });
});

describe('clientIp', () => {
  it('取 x-forwarded-for 第一段', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' });
    expect(clientIp(h)).toBe('203.0.113.9');
  });

  it('没有代理头时回退', () => {
    expect(clientIp(new Headers(), 'fallback')).toBe('fallback');
  });

  it('x-real-ip 次之', () => {
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.1' }))).toBe('198.51.100.1');
  });
});
