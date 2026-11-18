/* ------------------------------------------------------------------
 * prod 启动器 —— 一条进程同时托管静态产物与 BFF
 * 用法：pnpm build && pnpm start
 * 依据：docs/10-技术决策-补充.md §0.4
 * ------------------------------------------------------------------ */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
/*
 * 生产模式同样要读 .env。
 *
 * createApp() 内部确实会调 loadEnv()，但那是「模块被 import 时」——
 * 而 standalone.ts 在它<b>之前</b>就读取了 process.env.PORT。
 * 更关键的是，如果只在 index.ts 里加载，任何在 createApp 之前
 * 读取环境变量的代码都会拿到未初始化的值。
 *
 * 这里显式先加载一次，保证顺序确定。loadEnv 是幂等的，重复调用无害。
 */
import { loadEnv } from './env.js';
import { createApp } from './index.js';

loadEnv();

const PORT = Number(process.env.PORT ?? 5173);
const DIST = resolve(import.meta.dirname, '../dist');

/**
 * 生产模式下静态文件根目录。
 *
 * <p>serveStatic 的 root 是相对 <b>进程工作目录</b> 解析的，
 * 而我们算好的 DIST 是绝对路径。直接把绝对路径传给它，
 * 在 Windows 上会被拼成 "C:\\...\\D:\\project\\...\\dist" 这种非法路径。
 * 所以这里转成相对 cwd 的路径；转不了就退化用 dist。
 */
import { relative, isAbsolute } from 'node:path';

const staticRoot = (() => {
  const rel = relative(process.cwd(), DIST);
  return rel.startsWith('..') || isAbsolute(rel) ? DIST : rel;
})();

/**
 * CORS 白名单。
 *
 * <p>同源部署（前端 dist 与本进程同一端口）不需要 CORS，所以默认留空 ——
 * 留空时 createApp 内部退回 http://localhost:5173，同源请求根本不触发预检。
 * 只有把前端放到别的域名（例如 CDN + 独立 BFF）时才需要设 ALLOW_ORIGIN，
 * 否则浏览器会因 CORS 失败且报错很含糊。
 */
const app = createApp({ allowOrigin: process.env.ALLOW_ORIGIN || undefined });

// SPA 回退：非 /api 的请求一律交给 index.html（React Router 自己接管路由）
app.use('/*', serveStatic({ root: staticRoot }));
app.get('*', (c) => {
  try {
    const html = readFileSync(resolve(DIST, 'index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text('dist/index.html 不存在，请先执行 pnpm build', 500);
  }
});

/*
 * 监听地址要显式给。
 *
 * @hono/node-server 默认绑 0.0.0.0，但容器平台（Render / Fly / K8s）
 * 的健康检查来自容器外部，一旦哪天默认值变成 127.0.0.1，症状是
 * 「本地 docker run 一切正常、平台上一直 unhealthy」，排查成本很高。
 * 显式声明，顺带留一个 HOST 变量给只监听回环的场景。
 */
const HOST = process.env.HOST ?? '0.0.0.0';

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info: { port: number }) => {
  console.log(`[zhidao] listening on ${HOST}:${info.port}`);
});
