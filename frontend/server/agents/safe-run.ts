/* ------------------------------------------------------------------
 * Agent 安全执行包装 —— 「不允许异常穿透」的唯一保证点
 * 依据：docs/05-Agent契约表.md §0.3
 *
 * 任何 Agent 的失败都必须转成 AgentOutput.status = 'failed' | 'blocked'，
 * 绝不能让异常冒到 SSE 连接层（那里冒出去就是 500 + 前端白屏）。
 * ------------------------------------------------------------------ */

import type { AgentOutput, DegradeInfo } from '@shared/types/contract';

/** Agent 统一签名：吃信封，吐信封 */
export type AgentHandler<I, O> = (input: I) => Promise<AgentOutput<O>>;

export class AgentTimeoutError extends Error {
  constructor(
    public readonly agent: string,
    public readonly ms: number,
  ) {
    super(`agent ${agent} timed out after ${ms}ms`);
    this.name = 'AgentTimeoutError';
  }
}

export class AgentBlockedError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'AgentBlockedError';
  }
}

/**
 * 用超时包裹一个异步操作。**不吞异常**，只做"到点就抛"。
 * 与 safeRun 配合：超时异常最终会被 safeRun 转成 failed。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, agent: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentTimeoutError(agent, ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface SafeRunOptions<O> {
  agent: string;
  timeoutMs?: number;
  /** 兜底输出：异常时用它顶替，避免前端拿到空 payload */
  fallback: AgentOutput<O>;
}

/**
 * 包住任意 Agent 调用，把三种失败变成可控的 status：
 *
 *   AgentBlockedError  → blocked（业务拦截，非错误）
 *   AgentTimeoutError  → failed + degraded
 *   其他异常           → failed + degraded
 *
 * 永不抛出。
 */
export async function safeRun<I, O>(
  handler: AgentHandler<I, O>,
  input: I,
  opts: SafeRunOptions<O>,
): Promise<AgentOutput<O>> {
  const { agent, timeoutMs = 8000, fallback } = opts;

  try {
    const out = await withTimeout(handler(input), timeoutMs, agent);
    // 防御：handler 返回了非法 status 视为失败
    if (!isValidStatus(out?.status)) {
      return fail(fallback, {
        stage: agent,
        reason: 'agent returned invalid status',
        fallback: 'fallback-output',
      });
    }
    return out;
  } catch (err) {
    if (err instanceof AgentBlockedError) {
      return {
        ...fallback,
        status: 'blocked',
        degraded: { stage: agent, reason: err.reason, fallback: 'blocked-by-rule' },
      };
    }

    const degrade: DegradeInfo =
      err instanceof AgentTimeoutError
        ? { stage: agent, reason: `timeout ${err.ms}ms`, fallback: 'fallback-output' }
        : { stage: agent, reason: describe(err), fallback: 'fallback-output' };

    return fail(fallback, degrade);
  }
}

function fail<O>(fallback: AgentOutput<O>, degrade: DegradeInfo): AgentOutput<O> {
  return { ...fallback, status: 'failed', confidence: 0, degraded: degrade };
}

function isValidStatus(s: unknown): boolean {
  return s === 'ok' || s === 'need_clarify' || s === 'blocked' || s === 'failed';
}

/** 把任意异常转成一行可读原因，绝不带出 payload 内容 */
function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 200);
  return String(err).slice(0, 200);
}

/** 造一个空信封，作为各 Agent 的 fallback 底座 */
export function emptyOutput<O>(payload: O): AgentOutput<O> {
  return { status: 'ok', payload, confidence: 0, evidence: [], events: [] };
}
