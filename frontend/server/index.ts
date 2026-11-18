/* ------------------------------------------------------------------
 * Node BFF 入口 —— Vite 没有服务端，Agent 编排必须跑在这里
 * 依据：docs/10-技术决策-补充.md §0.4
 *
 * dev  ：vite.config.ts 的 configureServer 挂载，同端口 5173，无跨域
 * prod ：standalone.ts 单独启动，同时静态托管 dist
 *
 * 边界铁律：密钥只在这里出现，永不进入 src/（浏览器侧）。
 * ------------------------------------------------------------------ */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
// ⚠️ 必须最先执行：把 .env 读进 process.env。
// Vite 的 loadEnv 只注入前端（import.meta.env），Node 侧读不到 ——
// 少了这一行，用户按 README 填好的 LLM_API_KEY 永远不会生效。
import { loadEnv } from './env.js';
import { chatRoutes } from './routes/chat.js';
import { healthRoutes } from './routes/health.js';
import { modelRoutes } from './routes/models.js';
import { backendRoutes } from './routes/backend-proxy.js';
import { ocrRoutes } from './routes/ocr.js';
import { llmConfigRoutes } from './routes/llm-config.js';
import { reportRoutes } from './routes/report.js';

loadEnv();

export interface AppOptions {
  /** dev 期允许的源；prod 同源可留空 */
  allowOrigin?: string;
}

export function createApp(opts: AppOptions = {}) {
  const app = new Hono();

  // 仅 dev 需要；prod 由一个进程同时托管静态与 API，同源无 CORS
  app.use('*', cors({ origin: opts.allowOrigin ?? 'http://localhost:5173' }));

  app.route('/api/health', healthRoutes);
  app.route('/api/chat', chatRoutes);
  /*
   * 模型配置：/api/llm-config
   *
   * 用户在前端设置页填 url / apikey / 模型名，提交到这里。
   * Key 只进进程内存，不回显、不落盘 —— 见 routes/llm-config.ts 的头注释。
   */
  app.route('/api/llm-config', llmConfigRoutes);
  /*
   * 后端代理：/api/backend/* → Spring Boot 的 /*
   *
   * 放在 /api 下而不是根路径，因为它本质是业务 API 而不是静态资源；
   * 前端写 `/api/backend/records` 就知道这是"转发到后端"。
   */
  app.route('/api/backend', backendRoutes);
  /*
   * 院内导航：/api/nav/* → 后端 /api/nav/*
   *
   * 复用同一个转发实现（它会认 backend 与 nav 两种前缀）。
   * 单独挂一条是因为导航不需要登录 —— 患者站在楼里找路时
   * 不该先被要求登录，而 /api/backend 那套默认带患者身份。
   */
  app.route('/api/nav', backendRoutes);
  /*
   * HIS 相关：/api/his/* → 后端 /api/his/*
   *
   * 一条前缀下有两类调用方，后端按路径区分鉴权：
   *   · /api/his/places、/patient-report 等 —— 院方服务器调用，
   *     用 appKey + HMAC 签名，不带 JWT
   *   · /api/his/my-access-log、/binding 等 —— 患者查自己的数据，必须带 JWT
   *
   * BFF 这一层只做转发，不解析身份 —— 鉴权全部在后端做，
   * 避免两处各有一套判断逻辑而产生分歧。
   */
  app.route('/api/his', backendRoutes);
  /*
   * 报告图识别：/api/ocr/report
   *
   * 这是唯一会把非文本内容交给模型服务商的路径 ——
   * 图片像素没法在浏览器里脱敏，识别必须发生在能看到图的地方。
   * 识别出的文本在出关口再脱敏一次（见 routes/ocr.ts 的说明）。
   */
  app.route('/api/ocr', ocrRoutes);
  /*
   * 报告解读：/api/report/terms
   *
   * 只做「术语 → 白话」的补词，不生成结论。
   * 内置词库在前端（src/lib/health/glossary.ts），这一层只处理
   * 词库没有覆盖到的词 —— 所以它可以不配 Key 也能整页可用。
   */
  app.route('/api/report', reportRoutes);
  /*
   * 模型文件代理。路径刻意与 HuggingFace 保持一致
   * （/{repo}/resolve/main/{file}），这样 transformers.js 只要把
   * remoteHost 指向本站根路径就能直接用，不需要改它的加载逻辑。
   *
   * 挂在根路径而不是 /api 下：transformers.js 拼 URL 时是
   * `${remoteHost}/${modelId}/resolve/main/${file}`，
   * 如果塞进 /api 前缀，remoteHost 就得写成 "http://host/api"，
   * 而它同时还会去取 /api/api/... 这种二次拼接，容易出错。
   */
  app.route('/', modelRoutes);

  app.onError((err, c) => {
    // 只记类型与消息，绝不记 payload —— 原文不落服务端日志（08 §2）
    console.error('[bff] unhandled', err.name, err.message);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

/** 给 standalone.ts 复用：拿到默认实例如需直接监听 */
export const app = createApp();
