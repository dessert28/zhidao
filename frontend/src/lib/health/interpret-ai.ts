/* ------------------------------------------------------------------
 * 让模型补充术语 —— 用户点一下才调用
 *
 * ============ 为什么不自动调 ============
 *
 * 病历页一次能列出五六份报告。如果每张卡一渲染就请求，
 * 打开一次页面就是五次模型调用，其中大半用户根本没看 ——
 * 额度烧在没人读的内容上，而且会让首屏变慢。
 *
 * 所以入口是一个按钮：点了才发，一次一份，结果用完就留在内存里。
 *
 * ============ 失败不是错误 ============
 *
 * 没配 Key、超时、模型不听话，全部落回「内置词库」——
 * 界面照常显示已有注解，只在按钮下面补一句说明。
 * 报告解读不能因为模型不可用就变成白屏。
 * ------------------------------------------------------------------ */

import type { TermHit } from './glossary';

export type AiTermsFailure = 'no_model' | 'rate_limited' | 'failed' | 'network';

export interface AiTermsResult {
  ok: boolean;
  terms: TermHit[];
  /** 失败时给界面看的一句话 */
  message?: string;
  reason?: AiTermsFailure;
}

/** 单次请求上限，超时就当失败 —— 用户已经点开了报告，不该被一个网络请求吊住 */
const TIMEOUT_MS = 20_000;

/**
 * 请求模型补词。
 *
 * <p>传进来的 text 是库里那份**脱敏后**的正文，与上传时入库的内容一致，
 * 这里不再做二次处理（服务端出关口还有一层过滤）。
 */
export async function fetchAiTerms(text: string, known: string[]): Promise<AiTermsResult> {
  if (!text.trim()) return { ok: false, terms: [], reason: 'failed', message: '没有可解释的文本' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch('/api/report/terms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, known }),
      signal: ctrl.signal,
    });

    const json = (await res.json()) as {
      ok?: boolean;
      terms?: Array<{ term: string; explanation: string }>;
      reason?: string;
      message?: string;
    };

    if (!res.ok || !json.ok) {
      return {
        ok: false,
        terms: [],
        reason: (json.reason as AiTermsFailure) ?? 'failed',
        message: json.message ?? '这次没取到补充解释',
      };
    }

    const terms: TermHit[] = (json.terms ?? []).map((t) => ({
      term: t.term,
      explanation: t.explanation,
      category: '通用' as const,
      at: text.indexOf(t.term),
      fromAi: true,
    }));

    return { ok: true, terms };
  } catch {
    return { ok: false, terms: [], reason: 'network', message: '网络不通，暂时只用内置词库' };
  } finally {
    clearTimeout(timer);
  }
}
