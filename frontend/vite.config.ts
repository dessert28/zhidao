import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * React 18 + Vite 6 —— 决策见 docs/10-技术决策-补充.md D7
 *
 * 大作业分支：BFF 已下线，AI 编排与业务 API 全部迁移到 Spring Boot。
 * dev 期由 Vite proxy 把 /api/* 转发到后端（:8080），前端代码不出现后端地址；
 * prod 期由 Spring Boot 同源托管静态产物。
 *
 * 这里曾经挂着 Node BFF（zhidao-bff 插件），现在删掉了 —— 那个插件为了绕开
 * 跨域把 Hono 挂到同一端口，还踩过"中间件注册晚于 SPA fallback 导致 /api 返回
 * index.html"的坑。改用标准 proxy 后这类问题不复存在。
 */
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src', import.meta.url)),
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
    /*
     * 所有 /api 走 Spring Boot。changeOrigin 让后端看到的 Host 是它自己，
     * 避免 Spring Security 因 Host 不匹配拒绝请求。
     * SSE（/api/chat）也走这条代理 —— Vite 的 http-proxy 默认支持流式转发。
     */
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
