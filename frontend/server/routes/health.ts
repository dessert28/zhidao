import { Hono } from 'hono';
import { describeConfig, isLlmConfigured } from '../llm/client.js';

export const healthRoutes = new Hono();

/**
 * 健康检查：区分"进程活着"与"AI 可用"。
 * 演示翻车时先看这个，能快速判断是网络还是编排层。
 *
 * <p>三个字段各有分工：
 * <ul>
 *   <li>{@code llmConfigured} —— 有没有配 Key（决定走模型还是走规则）</li>
 *   <li>{@code llm} —— 会用哪家、哪个模型。**只报模型名，永不回显 Key**</li>
 *   <li>{@code degraded} —— 配了但没配全（比如只有 Key 没有 provider，
 *       或者 provider 拼错）。这种情况不报错，但要在健康检查里看得见，
 *       否则"以为接了模型其实一直在走规则"会一直查不出来</li>
 * </ul>
 */
healthRoutes.get('/', (c) =>
  c.json({
    ok: true,
    service: 'zhidao-bff',
    llmConfigured: isLlmConfigured(),
    llm: describeConfig(),
    // 从未配置到已配置，前端不需要知道；这里给运维/答辩现场一个明确信号
    mode: isLlmConfigured() ? 'llm' : 'rule-routing',
    ts: new Date().toISOString(),
  }),
);
