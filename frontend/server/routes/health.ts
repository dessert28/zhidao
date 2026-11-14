import { Hono } from 'hono';
import { describeConfig, isLlmConfigured } from '../llm/client.js';
import { envSource } from '../env.js';

export const healthRoutes = new Hono();

/**
 * 健康检查：区分"进程活着"与"AI 可用"。
 * 演示翻车时先看这个，能快速判断是网络还是编排层。
 *
 * <p>字段分工：
 * <ul>
 *   <li>{@code llmConfigured} —— 有没有配 Key（决定走模型还是走规则）</li>
 *   <li>{@code llm} —— 会用哪家、哪个模型。**只报模型名，永不回显 Key**</li>
 *   <li>{@code mode} —— {@code llm} 或 {@code rule-routing}，一眼看出当前状态</li>
 *   <li>{@code envSource} —— 配置是从哪读来的（.env / .env.local / 系统环境变量）。
 *       "填了 .env 却没生效"是实际踩过的坑，这个字段让它可诊断</li>
 * </ul>
 */
healthRoutes.get('/', (c) =>
  c.json({
    ok: true,
    service: 'zhidao-bff',
    llmConfigured: isLlmConfigured(),
    llm: describeConfig(),
    mode: isLlmConfigured() ? 'llm' : 'rule-routing',
    envSource: envSource(),
    ts: new Date().toISOString(),
  }),
);
