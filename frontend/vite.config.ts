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
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'zhidao-bff',
      configureServer(server: ViteDevServer) {
        // 延迟到 dev 启动才加载 BFF，避免 build 阶段初始化 Hono
        void import('./server/index.ts').then(({ createApp }) => {
          const app = createApp();
          // Hono 的 fetch 是 Web 标准签名，Connect 中间件是 Node 风格，这里做桥接
          server.middlewares.use((req, res, next) => {
            const url = `http://${req.headers.host ?? 'localhost'}${req.originalUrl ?? req.url ?? '/'}`;
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
              .catch(next);
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
