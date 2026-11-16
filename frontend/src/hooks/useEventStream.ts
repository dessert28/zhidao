/* ------------------------------------------------------------------
 * useEventStream —— 手写 SSE 消费（docs/10 D5）
 *
 * 为什么不用 TanStack Query 包 SSE：
 *   Query 的心智模型是"请求-响应-缓存"，一次请求拿一个结果。
 *   SSE 是一次请求拿 N 个不同类型的事件，其中 token 只是其中一类。
 *   硬塞进去就变成"用 mutation 收流"，缓存的 stale/refetch 语义全失效。
 *
 * 为什么不用 EventSource：
 *   EventSource 只支持 GET，发不了请求体；也不能自定义 header。
 *   这里用 fetch + ReadableStream 手动解析帧。
 * ------------------------------------------------------------------ */

import { useCallback, useRef, useState } from 'react';
import type { AgentEvent } from '@shared/types/events';
import { composeRequestText } from '../lib/privacy/context';

/** 服务端 enrich 后附加的字段，与 server/sse.ts 的 UiPayload 对应
 *
 * 用交叉类型而非 interface extends：AgentEvent 是可辨识联合，
 * 联合类型无法被 interface 继承，而且交叉后仍保留按 type 收窄的能力。
 */
export type StreamEvent = AgentEvent & {
  html?: string;
  props?: Record<string, unknown>;
};

export interface Turn {
  turnId: string;
  userText: string;
  events: StreamEvent[];
  /** 流式拼接的正文；token 事件追加到这里 */
  text: string;
  status: 'streaming' | 'done' | 'error';
}

export interface SendOptions {
  text: string;
  facts?: Record<string, unknown>;
  knownSlots?: Record<string, unknown>;
  round?: number;
  /**
   * 附在用户问题前的上下文（如健康档案摘要）。
   *
   * <p><b>它不是原样发送的</b>：和问题一样要过一遍脱敏，再拼进 text。
   * 原来这里是直接字符串拼接 —— 输入框那段遮过了，档案这段没有。
   * 见 lib/privacy/context.ts。
   */
  context?: string;
  lowScoreStreak?: number;
}

/** 一个 SSE 帧：event 名 + data 载荷 */
interface Frame {
  event: string;
  data: string;
}

/**
 * 增量解析 SSE 帧。
 * 返回 [完整帧列表, 剩余未闭合的缓冲]。
 *
 * 必须处理"一帧被切在两次 read 之间"的情况 ——
 * 这是手写 SSE 最容易出的 bug，网络一慢就复现。
 */
export function parseFrames(buffer: string): [Frame[], string] {
  const frames: Frame[] = [];
  const parts = buffer.split('\n\n');
  // 最后一个可能是半帧，留着和下次的数据拼接
  const rest = parts.pop() ?? '';

  for (const block of parts) {
    if (!block.trim()) continue;
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // 注释/心跳
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }

    if (dataLines.length > 0) {
      frames.push({ event, data: dataLines.join('\n') });
    }
  }

  return [frames, rest];
}

export function useEventStream() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 分诊会话状态 —— **跨轮保持**。
   *
   * <p>这是修复"记不住话"的核心。之前每轮 `send({ text })` 都不带状态，
   * 服务端每次从 `knownSlots: {} / round: 0` 开始，于是：
   * <ul>
   *   <li>用户答过「好几天了」，下一轮又问「多久了」</li>
   *   <li>「最多追问 3 轮」的熔断永远触发不了，因为它以为一直是第 1 轮</li>
   * </ul>
   *
   * <p>放 ref 不放 state：它只在发请求时被读取，不需要触发重渲染。
   * 放 state 会多一次 render，而且容易读到旧值。
   */
  const sessionRef = useRef<{ slots: Record<string, string | undefined>; round: number }>({
    slots: {},
    round: 0,
  });

  const send = useCallback(async (opts: SendOptions) => {
    const turnId = crypto.randomUUID();

    setBusy(true);
    setTurns((prev) => [
      ...prev,
      { turnId, userText: opts.text, events: [], text: '', status: 'streaming' },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    /** 幂等地往某一轮追加内容 */
    const patch = (fn: (t: Turn) => Turn) => {
      setTurns((prev) => prev.map((t) => (t.turnId === turnId ? fn(t) : t)));
    };

    try {
      /*
       * 上下文与问题分别脱敏后再拼接 —— 这是**唯一**组装请求体的地方。
       *
       * 放在这里而不是交给调用方：调用方只需要给"原始的档案摘要"，
       * 不需要知道还要脱敏。少一次"记得自己脱敏"的机会，就少一次漏掉的机会。
       */
      const { text: outboundText } = await composeRequestText(opts.context ?? '', opts.text);

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          turnId,
          sessionId: 'session-1',
          text: outboundText,
          facts: opts.facts,
          // 关键：把上一轮攒下的槽位与轮次带上，
          // 服务端才知道"这个槽位已经问过了"
          knownSlots: opts.knownSlots ?? sessionRef.current.slots,
          round: opts.round ?? sessionRef.current.round,
          lowScoreStreak: opts.lowScoreStreak,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const [frames, rest] = parseFrames(buffer);
        buffer = rest;

        for (const f of frames) {
          let evt: StreamEvent;
          try {
            evt = JSON.parse(f.data) as StreamEvent;
          } catch {
            continue; // 坏帧跳过，不让一条脏数据毁掉整轮
          }

          if (evt.type === 'done') {
            /*
             * 收下服务端回传的会话状态。
             *
             * 这一步决定"能不能记住上一轮说了什么"：
             * 不存，下一轮发出去的 knownSlots 还是空的，服务端就会重问。
             */
            if (evt.session) {
              sessionRef.current = {
                slots: evt.session.slots ?? {},
                round: evt.session.round ?? 0,
              };
            }
            patch((t) => ({ ...t, status: 'done' }));
            continue;
          }

          patch((t) => ({
            ...t,
            events: [...t.events, evt],
            text: evt.type === 'token' ? t.text + evt.text : t.text,
          }));
        }
      }

      patch((t) => (t.status === 'streaming' ? { ...t, status: 'done' } : t));
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      patch((t) => ({
        ...t,
        status: aborted ? 'done' : 'error',
        events: aborted
          ? t.events
          : [
              ...t.events,
              {
                type: 'caveat',
                text: '连接中断了，请检查网络后重试。如果反复失败，可能是服务未启动。',
              },
            ],
      }));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setTurns([]);
  }, []);

  return { turns, busy, send, stop, reset };
}
