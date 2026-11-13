import { Hono } from 'hono';

export const healthRoutes = new Hono();

/**
 * 健康检查：区分"进程活着"与"AI 可用"。
 * 演示翻车时先看这个，能快速判断是网络还是编排层。
 */
healthRoutes.get('/', (c) =>
  c.json({
    ok: true,
    service: 'zhidao-bff',
    // 不打印密钥本身，只报是否配置 —— 排查配错用
    llmConfigured: Boolean(process.env.LLM_API_KEY),
    llmModel: process.env.LLM_MODEL ?? null,
    ts: new Date().toISOString(),
  }),
);
