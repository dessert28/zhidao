import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vitest 配置（从 vite.config.ts 里拆出来）。
 *
 * <p>为什么拆：vite.config.ts 里的 bff 插件会在 `configureServer` 里
 * `await import('./server/index.ts')`，这会把整个 Node BFF（含 Hono、
 * 以及未来的 LLM SDK）带进任何加载该配置的进程。测试不需要那套东西，
 * 而且 Hono 的初始化在有副作用的 import 里会拖慢每次 test 的启动。
 *
 * <p>这里只保留测试真正需要的两件事：alias 与 jsdom 环境。
 * 注意 `@shared` 与 `@server` 的映射必须和 vite.config.ts 保持一致，
 * 否则测试里 import 能过、跑 dev 就找不到 —— 反过来更糟。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src', import.meta.url)),
      '@server': fileURLToPath(new URL('./server', import.meta.url)),
    },
  },
  test: {
    // 用 jsdom：react hook 测试需要 DOM（renderHook 要挂一个容器）
    environment: 'jsdom',
    // 只跑我们自己写的测试，不扫 node_modules 与产物
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.{ts,tsx}'],
    // 端侧脱敏与检索这些纯函数不需要 DOM，但用同一环境无害，
    // 统一起来比按文件配置 globals 简单
  },
});
