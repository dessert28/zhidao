/* ------------------------------------------------------------------
 * 后端代理 —— 浏览器只跟 5173 说话，由 BFF 转发到 Spring Boot
 *
 * ============ 为什么不让浏览器直连 8080 ============
 *
 * 1. **CORS**。Spring Security 默认不放行跨源请求，浏览器直连
 *    会先收到一个 OPTIONS 预检，然后被拒。要让直连成立就得在后端
 *    加 CORS 配置 —— 那是为了开发方便而放宽一个生产安全边界，
 *    不值得。
 *
 * 2. **同源部署**。生产环境本来就该是一个域名：静态产物 + BFF +
 *    后端都在同一台机器上。BFF 转发让它天然同源，
 *    前端代码里写 `/api/records` 就够了，换环境不用改。
 *
 * 3. **失败可诊断**。后端没起时，浏览器直连拿到的是
 *    ERR_CONNECTION_REFUSED，前端只能显示"网络错误"；
 *    走 BFF 可以返回 503 + 一句「后端未启动」，
 *    评审现场一眼知道该起哪个进程。
 *
 * ============ 边界 ============
 *
 * 这一层**只做转发，不做业务**。不解析响应体、不加字段、
 * 不做缓存。一旦开始在这里"顺手处理一下"，就会出现两份业务逻辑
 * —— 而 docs/04 §1 已经明确：业务在后端，AI 编排在前端。
 * ------------------------------------------------------------------ */

import { Hono } from 'hono';

export const backendRoutes = new Hono();

/** 后端地址。留空则视为"未部署后端"，接口返回 503 而不是报错 */
function backendBase(): string {
  return (process.env.BACKEND_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
}

/**
 * 后端是否被显式禁用。
 * 设成 `none` 或空字符串表示"本次演示不启后端"，
 * 此时前端应当只展示提示，而不是反复重试连接。
 */
function backendDisabled(): boolean {
  const v = (process.env.BACKEND_BASE_URL ?? '').trim().toLowerCase();
  return v === 'none';
}

/**
 * 需要透传给后端的请求头白名单。
 *
 * <p>不透传全部：`host`、`content-length`、`connection` 这些由
 * fetch 自己算，硬塞会出错（实测传 host 会导致后端 400）。
 */
const PASS_HEADERS = ['authorization', 'content-type', 'accept', 'accept-language'];

backendRoutes.all('/*', async (c) => {
  if (backendDisabled()) {
    return c.json(
      {
        error: 'backend_disabled',
        message: '后端未启用（BACKEND_BASE_URL=none）。病历、提醒、预约功能不可用。',
      },
      503,
    );
  }

  const url = new URL(c.req.url);
  // 去掉 /api/backend 前缀，剩下的是后端真实路径
  const rest = url.pathname.replace(/^\/api\/backend/, '') || '/';
  const target = `${backendBase()}${rest}${url.search}`;

  const headers: Record<string, string> = {};
  for (const h of PASS_HEADERS) {
    const v = c.req.header(h);
    if (v) headers[h] = v;
  }

  // 只对写操作读 body；GET/HEAD 不带 body（带了 fetch 会报错）
  const method = c.req.method;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? await c.req.arrayBuffer() : undefined;

  let resp: Response;
  try {
    resp = await fetch(target, {
      method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      // 后端是我们自己的，不需要跟随时序问题
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    /*
     * 连不上后端是**演示现场最常见的情况**（忘了起 mvn spring-boot:run）。
     * 这里必须给出可执行的信息，而不是一个笼统的 502。
     */
    const msg = err instanceof Error ? err.message : String(err);
    const unreachable = /ECONNREFUSED|fetch failed|timed out/i.test(msg);
    console.warn('[backend-proxy] 转发失败', method, rest, msg);
    return c.json(
      {
        error: unreachable ? 'backend_unreachable' : 'backend_error',
        message: unreachable
          ? `后端未启动或不可达（${backendBase()}）。请先执行：cd backend && mvn spring-boot:run`
          : '后端调用失败，请稍后重试。',
      },
      503,
    );
  }

  // 原样返回状态码与响应体；只转发 JSON 与文本
  const contentType = resp.headers.get('content-type') ?? 'application/json';
  const text = await resp.text();
  return c.body(text, resp.status as 200, { 'Content-Type': contentType });
});
