/* ------------------------------------------------------------------
 * SSE 编码器 —— 把 AgentEvent 变成 `event:` / `data:` 帧
 * 依据：docs/05-Agent契约表.md §6，docs/10 D7 §0.3
 *
 * 生成式 UI 的下发点也在这里：纯展示型事件携带 html，交互型携带 props。
 * ------------------------------------------------------------------ */

import type { AgentEvent } from '@shared/types/events';

/** 事件载荷里额外附加的 UI 渲染字段（由 server/render 填充） */
export interface UiPayload {
  /** 纯展示型组件：服务端 renderToString 的结果 */
  html?: string;
  /** 交互型组件必须带：客户端按 type 用本地同款组件渲染 */
  props?: Record<string, unknown>;
}

export type OutboundEvent = AgentEvent & UiPayload;

const encoder = new TextEncoder();

function frame(event: OutboundEvent): Uint8Array {
  const data = JSON.stringify(event);
  // SSE 允许 data 中出现多行，但 JSON 已转义换行，这里直接单行输出
  return encoder.encode(`event: ${event.type}\ndata: ${data}\n\n`);
}

export function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 关掉 Nginx 缓冲，否则流式被攒成一坨
    'X-Accel-Buffering': 'no',
  };
}

/**
 * 消费一个事件 producer，返回 ReadableStream，直接给 Hono 的 c.body。
 * 上游抛错不会冒到连接层：转成 done 事件后正常关闭。
 */
export function toSseStream(
  producer: (emit: (e: OutboundEvent) => void) => Promise<void>,
  meta: { turnId: string },
): ReadableStream<Uint8Array> {
  const startedAt = Date.now();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (e: OutboundEvent) => {
        if (closed) return;
        controller.enqueue(frame(e));
      };

      try {
        await producer(emit);
      } catch (err) {
        // 兜底：任何未捕获异常都变成一条 caveat + done，前端不会白屏
        const msg = err instanceof Error ? err.message : String(err);
        emit({
          type: 'caveat',
          text: '本轮回答未能完成，请稍后重试或转人工咨询。',
        });
        emit({
          type: 'done',
          turnId: meta.turnId,
          elapsedMs: Date.now() - startedAt,
          degraded: true,
        });
        console.error('[sse] producer failed', msg.slice(0, 200));
      } finally {
        // 若 producer 自己没发 done，这里补一发
        emit({
          type: 'done',
          turnId: meta.turnId,
          elapsedMs: Date.now() - startedAt,
          degraded: false,
        });
        closed = true;
        controller.close();
      }
    },
  });
}

/** 保活心跳，长连接防中间层超时（每 15s 一条注释帧） */
export function heartbeat(controller: ReadableStreamDefaultController<Uint8Array>): () => void {
  const timer = setInterval(() => {
    try {
      controller.enqueue(encoder.encode(': ping\n\n'));
    } catch {
      clearInterval(timer);
    }
  }, 15_000);
  return () => clearInterval(timer);
}
