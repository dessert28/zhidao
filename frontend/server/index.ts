/* ------------------------------------------------------------------
 * Node BFF 入口 —— Vite 没有服务端，Agent 编排必须跑在这里
 * 依据：docs/10-技术决策-补充.md §0.4
 *
 * dev  ：vite.config.ts 的 configureServer 挂载，同端口 5173，无跨域
 * prod ：standalone.ts 单独启动，同时静态托管 dist
 *
 * 边界铁律：密钥只在这里出现，永不进入 src/（浏览器侧）。
 * ------------------------------------------------------------------ */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
// ⚠️ 必须最先执行：把 .env 读进 process.env。
// Vite 的 loadEnv 只注入前端（import.meta.env），Node 侧读不到 ——
// 少了这一行，用户按 README 填好的 LLM_API_KEY 永远不会生效。
import { loadEnv } from './env.js';
import { chatRoutes } from './routes/chat.js';
import { healthRoutes } from './routes/health.js';

loadEnv();

export interface AppOptions {
  /** dev 期允许的源；prod 同源可留空 */
  allowOrigin?: string;
}

export function createApp(opts: AppOptions = {}) {
  const app = new Hono();

  // 仅 dev 需要；prod 由一个进程同时托管静态与 API，同源无 CORS
  app.use('*', cors({ origin: opts.allowOrigin ?? 'http://localhost:5173' }));

  app.route('/api/health', healthRoutes);
  app.route('/api/chat', chatRoutes);

  app.onError((err, c) => {
    // 只记类型与消息，绝不记 payload —— 原文不落服务端日志（08 §2）
    console.error('[bff] unhandled', err.name, err.message);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

/** 给 standalone.ts 复用：拿到默认实例如需直接监听 */
export const app = createApp();
