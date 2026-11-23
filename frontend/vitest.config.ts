import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vitest 配置（从 vite.config.ts 里拆出来）。
 *
 * <p>大作业分支：Node BFF 已下线，AI 编排与脱敏全部迁到 Spring Boot，
 * 这里不再需要 `@server` 映射，只保留前端自身的 alias 与 jsdom 环境。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // 用 jsdom：react hook 测试需要 DOM（renderHook 要挂一个容器）
    environment: 'jsdom',
    // 只跑前端自己的测试；BFF 已删除，server/** 不再存在
    include: ['src/**/*.test.{ts,tsx}'],
    // 端侧脱敏等纯函数不需要 DOM，但用同一环境无害，
    // 统一起来比按文件配置 globals 简单
  },
});
