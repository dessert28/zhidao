/* ------------------------------------------------------------------
 * 报告解读路由 —— POST /api/report/terms
 *
 * ============ 它做什么 ============
 *
 * 前端把**已经脱敏**的报告正文与词典已覆盖的词发过来，
 * 这一层让模型补上剩下那些患者不认识的术语，返回「词 + 一句白话」。
 *
 * 只在用户点「让 AI 补充术语」时才调用 —— 不随页面渲染自动触发。
 * 一份报告看一次就够了，自动调用会在病历页一次点开五张卡时
 * 连发五次请求，把额度烧在用户没看的报告上。
 *
 * ============ 边界 ============
 *
 * · 输入是脱敏文本（前端 redact 之后才入库，这里是库里那份）
 * · 输出再过一层过滤器（server/report/term-explainer.ts）
 * · 服务端不落日志、不存正文，只有失败原因
 * ------------------------------------------------------------------ */

import { Hono } from 'hono';
import { ChatLimiter, clientIp } from '../limit.js';
import { explainTerms } from '../report/term-explainer.js';

export const reportRoutes = new Hono();

/**
 * 单独的限流桶。
 *
 * <p>不和对话共用：一次报告解读的额度消耗接近一轮对话，
 * 如果共用，用户连着看几份报告就会把当天的问诊额度用掉 ——
 * 那时候他会以为"AI 坏了"。分开计数，各自被限制时提示也准确。
 */
const limiter = new ChatLimiter({
  perIpPerMinute: 6,
  dailyQuota: 200,
  maxConcurrent: 2,
});

interface TermsBody {
  /** 脱敏后的报告正文 */
  text: string;
  /** 内置词库已经解释过的词，避免重复 */
  known?: string[];
}

reportRoutes.post('/terms', async (c) => {
  const ip = clientIp(c.req.raw.headers, 'unknown');
  const verdict = limiter.enter(ip);
  if (!verdict.ok) {
    return c.json(
      { ok: false, reason: 'rate_limited', message: verdict.message },
      429,
      { 'Retry-After': String(verdict.retryAfterSec) },
    );
  }

  try {
    let body: TermsBody;
    try {
      body = await c.req.json<TermsBody>();
    } catch {
      return c.json({ ok: false, reason: 'bad_input', message: '请求格式不正确' }, 400);
    }

    if (!body?.text || typeof body.text !== 'string' || !body.text.trim()) {
      return c.json({ ok: false, reason: 'bad_input', message: '缺少报告正文' }, 400);
    }

    const known = Array.isArray(body.known)
      ? body.known.filter((k): k is string => typeof k === 'string').slice(0, 40)
      : [];

    const r = await explainTerms({ text: body.text, known });

    if (!r.ok) {
      // 只记原因，不记正文
      console.warn('[report] 术语补词未完成', r.reason);
      return c.json({ ok: false, reason: r.reason, message: r.message }, 200);
    }

    return c.json({ ok: true, terms: r.terms });
  } finally {
    limiter.leave();
  }
});
