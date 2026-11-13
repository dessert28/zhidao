/* ------------------------------------------------------------------
 * prod 启动器 —— 一条进程同时托管静态产物与 BFF
 * 用法：pnpm build && pnpm start
 * 依据：docs/10-技术决策-补充.md §0.4
 * ------------------------------------------------------------------ */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './index.js';

const PORT = Number(process.env.PORT ?? 5173);
const DIST = resolve(import.meta.dirname, '../dist');

const app = createApp({ allowOrigin: undefined });

// SPA 回退：非 /api 的请求一律交给 index.html（React Router 自己接管路由）
app.use('/*', serveStatic({ root: DIST }));
app.get('*', (c) => {
  try {
    const html = readFileSync(resolve(DIST, 'index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text('dist/index.html 不存在，请先执行 pnpm build', 500);
  }
});

serve({ fetch: app.fetch, port: PORT }, (info: { port: number }) => {
  console.log(`[zhidao] http://localhost:${info.port}`);
});
