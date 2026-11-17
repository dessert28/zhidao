/* ------------------------------------------------------------------
 * 模型配置接口 —— 让用户在界面上填 url / apikey / 模型名
 *
 * ============ 安全边界（这一段必须读完再改） ============
 *
 * 用户选择了 "Key 存浏览器 localStorage"。这意味着：
 *
 *   1. **服务端不持久化 Key**。这里只把它放进进程内存，
 *      下一次请求前端会再带上来。进程重启即忘。
 *   2. **任何能访问这个页面的人都能改配置**。这是演示优先的取舍，
 *      用户明确选了它。所以部署到公网前必须知道这一点 ——
 *      文档里写了，界面上也写了。
 *   3. **接口从不回显 Key**。GET 只返回 provider/model/baseURL
 *      和一个 `hasKey` 布尔值。回显 Key 会让它进入浏览器历史、
 *      代理日志、截图。
 *
 * ============ 为什么需要一个"测试连接" ============
 *
 * 用户填完配置最想知道的是"能通吗"。让他去发一条问诊消息来验证，
 * 失败时看到的是"AI 调度暂不可用" —— 完全看不出是 Key 错了
 * 还是网络不通。所以单独一个探测接口，直接返回 401 / 连不上 / 超时。
 * ------------------------------------------------------------------ */

import { Hono } from 'hono';
import {
  probeLlm,
  readConfig,
  setRuntimeConfig,
  hasRuntimeConfig,
  describeConfig,
  listModels,
} from '../llm/client.js';

export const llmConfigRoutes = new Hono();

/**
 * 当前配置（不含 Key）。
 *
 * <p>`source` 告诉用户这份配置从哪来：
 *   · `runtime` —— 浏览器设置页提交的
 *   · `env`     —— 服务端 .env 里的
 *   · `none`    —— 都没配，走规则路由
 */
llmConfigRoutes.get('/', (c) => {
  const cfg = readConfig();
  return c.json({
    configured: cfg !== null,
    source: hasRuntimeConfig() ? 'runtime' : cfg ? 'env' : 'none',
    // 不收 apiKey —— 见文件头第 3 条
    provider: cfg?.provider ?? null,
    baseURL: cfg?.baseURL ?? null,
    model: cfg?.model ?? null,
  });
});

/**
 * 保存配置。
 *
 * <p>请求体 `{provider, baseURL, model, apiKey}`。
 * 传 `{apiKey: ''}` 或不传 body 表示清除 —— 回到环境变量。
 */
llmConfigRoutes.post('/', async (c) => {
  let body: { provider?: string; baseURL?: string; model?: string; apiKey?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid_json', message: '请求格式不对' }, 400);
  }

  const apiKey = (body.apiKey ?? '').trim();

  /* 空 Key = 清除覆盖，回到 .env 或规则路由 */
  if (!apiKey) {
    setRuntimeConfig(null);
    return c.json({
      ok: true,
      cleared: true,
      configured: readConfig() !== null,
      source: readConfig() ? 'env' : 'none',
    });
  }

  /*
   * baseURL 的校验只做"格式像不像一个 URL"。
   *
   * 不去 ping 它：用户填完之后会点「测试连接」，那一步才真的发请求。
   * 在这里同步 ping 会让保存动作变得很慢，而且失败信息还不如
   * 专门的测试按钮说得清楚。
   */
  const baseURL = (body.baseURL ?? '').trim();
  if (baseURL && !/^https?:\/\//i.test(baseURL)) {
    return c.json(
      { ok: false, error: 'invalid_base_url', message: '接口地址要以 http:// 或 https:// 开头' },
      400,
    );
  }

  setRuntimeConfig({
    apiKey,
    provider: body.provider ?? 'deepseek',
    baseURL,
    model: body.model ?? '',
  });

  const cfg = describeConfig();
  return c.json({ ok: true, configured: true, source: 'runtime', provider: cfg?.provider, model: cfg?.model });
});

/**
 * 拉取这家服务商支持哪些模型。
 *
 * <p>用它取代"手填模型名"的默认体验：填错模型名的表现是
 * 一句「模型不存在」，而用户根本不知道该填什么。
 *
 * <p>失败时**不报错**，返回一个可操作的说明 —— 界面据此
 * 退回手填模式。不是所有兼容实现都提供 /models。
 */
llmConfigRoutes.get('/models', async (c) => {
  const r = await listModels();

  if (r.ok) {
    return c.json({ ok: true, models: r.models, current: readConfig()?.model ?? null });
  }

  return c.json({
    ok: false,
    reason: r.reason,
    message:
      r.reason === 'not_configured'
        ? '请先填写 API Key 并保存，再拉取模型列表。'
        : r.reason === 'auth'
          ? 'API Key 无效，无法拉取模型列表。'
          : r.reason === 'unsupported'
            ? '这个服务商没有提供模型列表接口，请在下面手动填写模型名称。'
            : '连不上接口地址，无法拉取模型列表。请检查地址是否正确。',
    detail: r.detail,
  });
});

/**
 * 测试连接 —— 真的发一次请求。
 *
 * <p>返回的不是"成功/失败"，而是**失败的具体原因**：
 * Key 无效（401）、地址连不上、超时。这三种用户该做的事完全不同。
 */
llmConfigRoutes.post('/test', async (c) => {
  const started = Date.now();

  if (readConfig() === null) {
    return c.json({
      ok: false,
      reason: 'not_configured',
      message: '还没填 API Key。',
      latencyMs: 0,
    });
  }

  const r = await probeLlm();
  const latencyMs = Date.now() - started;

  if (r.ok) {
    const cfg = describeConfig();
    return c.json({
      ok: true,
      message: `连接正常，模型 ${cfg?.model ?? '未知'} 响应了 ${r.latencyMs}ms。`,
      latencyMs,
      modelLatencyMs: r.latencyMs,
    });
  }

  /*
   * 把 client.ts 里的失败分类翻译成用户能行动的话。
   * 不直接回显原始错误字符串 —— 里面可能带 baseURL 甚至 Key 的片段。
   *
   * <p>三类失败用户该做的事完全不同：
   *   · auth       → 换 Key
   *   · network    → 检查地址/网络
   *   · bad-output → 地址通了但不是兼容 OpenAI 的服务
   */
  const detail = (r.detail ?? '').split('\n')[0]?.slice(0, 160) ?? '未知错误';
  const reason =
    r.stage === 'auth'
      ? 'bad_key'
      : r.stage === 'network'
        ? 'unreachable'
        : r.stage === 'bad-output'
          ? 'bad_response'
          : /timeout/i.test(detail)
            ? 'timeout'
            : 'unknown';

  return c.json({
    ok: false,
    reason,
    message:
      reason === 'bad_key'
        ? 'API Key 无效或已过期，请检查后重新填写。'
        : reason === 'unreachable'
          ? '连不上这个地址。请检查接口地址是否正确、网络是否可达。'
          : reason === 'bad_response'
            ? '能连上，但返回的不是标准的 OpenAI 兼容格式。请确认这个地址是 API 接口而不是网页。'
            : reason === 'timeout'
              ? '请求超时了。地址可能是对的，但服务响应太慢。'
              : detail,
    detail,
    latencyMs,
  });
});
