import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import type { ViteDevServer } from 'vite';

/**
 * React 18 + Vite 5 —— 决策见 docs/10-技术决策-补充.md D7
 *
 * 三个关键点：
 *   1. bff 插件：dev 期把 Node BFF 挂到同一端口，彻底绕开跨域
 *   2. manualChunks：把 react / ai 拆出去，主包只留业务代码（性能 3%）
 *   3. 端侧模型不在此处理 —— Transformers.js 走动态 import，
 *      否则 ONNX runtime 会被打进首屏
 */
/**
 * 把 Node BFF 挂到 Vite dev server 上。
 *
 * <b>这里有一个必须写在代码里的坑（曾经导致 /api 全部 404）。</b>
 *
 * 最初的写法是：
 * <pre>
 *   configureServer(server) {
 *     void import('./server/index.ts').then(({ createApp }) => {
 *       server.middlewares.use(...)   // ← 注册发生在下一个微任务里
 *     })
 *   }
 * </pre>
 * 看起来是把 Hono 懒加载、避免 build 阶段初始化，很合理。实际后果是
 * <b>所有 /api 请求都返回了 index.html</b>：
 *
 * <ul>
 *   <li>Vite 在「configureServer 返回之后」才去注册自己的中间件
 *       （html 兜底、SPA fallback）</li>
 *   <li>我们那个 await 之后的 {@code use()} 排在它们<b>后面</b></li>
 *   <li>于是 /api/chat 先被 SPA fallback 命中，返回 200 + index.html，
 *       前端 fetch 拿到一坨 HTML，JSON.parse 失败 —— 表现为"点了没反应"，
 *       而且<b>没有任何报错</b>，因为 HTTP 状态是 200</li>
 * </ul>
 *
 * 修复方式：<b>注册必须同步完成</b>。BFF 的 import 本身是同步可用的
 * （Vite 配置加载时已经把 .ts 编译好），所以直接在 configureServer 里
 * 同步取模块、同步 use，中间件就排在 Vite 自己的兜底之前。
 *
 * 配套的第二道防线是路径守卫：不是 /api/ 开头的请求一律 next()，
 * 这样即使将来注册顺序再变，也不会吞掉静态资源与 HMR。
 */
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'zhidao-bff',
      async configureServer(server: ViteDevServer) {
        const { createApp } = await import('./server/index.ts');
        const app = createApp();

        // 注意：use() 写在 await 之后仍然有问题，见上面的说明。
        // 所以这里在拿到 app 之后立刻同步注册，且不依赖任何后续 await。
        server.middlewares.use((req, res, next) => {
          const urlPath = req.originalUrl ?? req.url ?? '/';
          // 只接管 /api 前缀。别的请求一律 next()，交给 Vite 处理静态与 HMR。
          if (!urlPath.startsWith('/api/')) return next();

          const url = `http://${req.headers.host ?? 'localhost'}${urlPath}`;
          const method = req.method ?? 'GET';

          // GET/HEAD 无 body，其余情况把 Node 流读成 ArrayBuffer 再交给 Hono
          const readBody = async (): Promise<ArrayBuffer | undefined> => {
            if (method === 'GET' || method === 'HEAD') return undefined;
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const buf = Buffer.concat(chunks);
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
          };

          void readBody()
            .then((body) =>
              app.fetch(
                new Request(url, {
                  method,
                  headers: req.headers as Record<string, string>,
                  body,
                }),
              ),
            )
            .then(async (resp) => {
              res.statusCode = resp.status;
              resp.headers.forEach((v, k) => res.setHeader(k, v));
              // SSE 必须逐块转发，不能被缓冲
              if (resp.body) {
                const reader = resp.body.getReader();
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  res.write(Buffer.from(value));
                }
              }
              res.end();
            })
            .catch((err) => {
              // 走到这里说明 BFF 自己炸了。不 next()：
              // next() 会让 Vite 返回 index.html，前端拿到 200 + HTML，
              // 比直接 502 更难查。
              console.error('[bff] 请求处理失败', method, urlPath, err);
              if (!res.headersSent) {
                res.statusCode = 502;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ type: 'caveat', text: '服务暂时不可用，请稍后重试。' }));
              } else {
                res.end();
              }
            });
        });
      },
    } satisfies Plugin,
  ],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src', import.meta.url)),
      '@server': fileURLToPath(new URL('./server', import.meta.url)),
    },
  },

  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          ai: ['ai', '@ai-sdk/openai'],
        },
      },
    },
  },

  server: {
    port: 5173,
    strictPort: true,
  },
});
