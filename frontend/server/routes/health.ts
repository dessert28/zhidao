import { Hono } from 'hono';
import { describeConfig, isLlmConfigured, readVisionConfig } from '../llm/client.js';
import { envSource } from '../env.js';
import { chatMetrics } from '../metrics-instance.js';
import { limiter } from './chat.js';

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
 *   <li>{@code quota} —— 今日已用/上限、当前并发。演示当天的"还能用多久"看这个</li>
 * </ul>
 */
healthRoutes.get('/', (c) =>
  c.json({
    ok: true,
    service: 'zhidao-bff',
    llmConfigured: isLlmConfigured(),
    llm: describeConfig(),
    /*
     * 识图用的模型。与 llm 可能是同一个（多模态模型两条路都跑），
     * 也可能被 LLM_OCR_MODEL 单独指定成视觉模型。
     * 上传图片报错时先看这里：null 就是根本没配，不是网络问题。
     */
    ocrModel: readVisionConfig()?.model ?? null,
    mode: isLlmConfigured() ? 'llm' : 'rule-routing',
    envSource: envSource(),
    quota: limiter.stats(),
    ts: new Date().toISOString(),
  }),
);

/**
 * 指标。
 *
 * <p>单独一个端点而不是塞进健康检查：
 * 健康检查是给负载均衡/探针用的，要求快、稳定、字段少；
 * 指标是给人和看板看的，字段会越来越多。混在一起，
 * 以后每加一个指标都在增加探针的响应体积。
 *
 * <p>这里暴露的是**聚合值**，不含任何用户文本 —— 隐私边界不变。
 */
healthRoutes.get('/metrics', (c) =>
  c.json({
    ok: true,
    service: 'zhidao-bff',
    ...chatMetrics.summary(),
    quota: limiter.stats(),
  }),
);
