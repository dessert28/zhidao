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

/**
 * 给事件补齐生成式 UI 的两个字段（D7）。
 *
 * **两条路径共用同一个事件**：html 给纯展示用，props 给交互用。
 * 不是二选一 —— 只给 html 的话客户端无法接管状态，
 * 只给 props 的话首帧无法直接内联（要多一次本地渲染）。
 *
 * 这里用动态 import 引 render/registry：registry 依赖 react-dom/server，
 * 静态引入会把它带进任何 import 了 sse.ts 的地方。
 */
async function enrich(e: OutboundEvent): Promise<OutboundEvent> {
  if (e.html !== undefined || e.props !== undefined) return e;
  try {
    const { renderEventToHtml, isRenderable } = await import('./render/registry.js');
    if (!isRenderable(e.type)) return e;
    const { type: _t, ...props } = e as unknown as Record<string, unknown> & { type: string };
    const html = renderEventToHtml(e.type, props);
    return html ? { ...e, html, props: props as Record<string, unknown> } : e;
  } catch {
    // 渲染失败不影响事件本身 —— 生成式 UI 是增强，不是前提
    return e;
  }
}

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

      /**
       * 事件入队前先跑一次 enrich（生成式 UI 渲染）。
       * 渲染是纯 CPU 的同步操作，但走 await 保持顺序 ——
       * 乱序下发会让前端把卡片插错位置。
       */
      const emit = (e: OutboundEvent) => {
        if (closed) return;
        void enrich(e).then(
          (out) => {
            if (closed) return;
            try {
              controller.enqueue(frame(out));
            } catch {
              closed = true;
            }
          },
          () => {
            /* enrich 内部已兜底，不会走到这里 */
          },
        );
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
        // 等 enrich 队列排空，否则 done 会插到卡片前面
        await new Promise((r) => setTimeout(r, 0));
        emit({
          type: 'done',
          turnId: meta.turnId,
          elapsedMs: Date.now() - startedAt,
          degraded: false,
        });
        await new Promise((r) => setTimeout(r, 0));
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
