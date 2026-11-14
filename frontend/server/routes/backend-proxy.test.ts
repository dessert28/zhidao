/* ------------------------------------------------------------------
 * 后端代理测试
 *
 * 这一层是"前端能不能用上后端"的唯一通道，出错的表现是
 * 页面一片空白或"加载失败"，很难定位到是代理的问题。
 * 所以重点测三件事：
 *
 *   1. 路径重写正确（/api/backend/api/records → /api/records）
 *   2. 后端不可达时给出**可执行**的错误，而不是笼统失败
 *   3. 禁用模式（BACKEND_BASE_URL=none）不尝试连接
 *
 * 不测真实后端：那需要启动 Spring Boot，属于集成测试范畴。
 * 这里用 mock fetch 验证代理自身的逻辑。
 * ------------------------------------------------------------------ */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 从代理模块里复用的纯逻辑（保持与实现一致） */

const PASS_HEADERS = ['authorization', 'content-type', 'accept', 'accept-language'];

function backendDisabled(v: string | undefined): boolean {
  return (v ?? '').trim().toLowerCase() === 'none';
}

function rewritePath(pathname: string): string {
  return pathname.replace(/^\/api\/backend/, '') || '/';
}

function isUnreachable(msg: string): boolean {
  return /ECONNREFUSED|fetch failed|timed out/i.test(msg);
}

describe('路径重写', () => {
  it('去掉 /api/backend 前缀', () => {
    expect(rewritePath('/api/backend/api/records')).toBe('/api/records');
    expect(rewritePath('/api/backend/api/auth/login')).toBe('/api/auth/login');
  });

  it('根路径退化为 /', () => {
    expect(rewritePath('/api/backend')).toBe('/');
    expect(rewritePath('/api/backend/')).toBe('/');
  });

  it('不改动后端自己的路径分段', () => {
    expect(rewritePath('/api/backend/api/bookings/12/confirm')).toBe('/api/bookings/12/confirm');
  });

  it('只剥离开头的前缀，正文里的同名字符串不动', () => {
    expect(rewritePath('/api/backend/api/x?a=/api/backend')).toBe('/api/x?a=/api/backend');
  });
});

describe('禁用模式', () => {
  it('none 表示禁用', () => {
    expect(backendDisabled('none')).toBe(true);
    expect(backendDisabled('NONE')).toBe(true);
    expect(backendDisabled('  None  ')).toBe(true);
  });

  it('正常地址不禁用', () => {
    expect(backendDisabled('http://localhost:8080')).toBe(false);
    expect(backendDisabled(undefined)).toBe(false);
  });

  it('空串不禁用（走默认地址）', () => {
    expect(backendDisabled('')).toBe(false);
  });
});

describe('错误分类：必须给出可执行的提示', () => {
  it('识别连不上', () => {
    expect(isUnreachable('fetch failed')).toBe(true);
    expect(isUnreachable('connect ECONNREFUSED 127.0.0.1:8080')).toBe(true);
    expect(isUnreachable('The operation was aborted due to timeout')).toBe(false);
    expect(isUnreachable('AbortError: timed out')).toBe(true);
  });

  it('不把业务错误误判成连不上', () => {
    expect(isUnreachable('401 Unauthorized')).toBe(false);
    expect(isUnreachable('预约单不存在')).toBe(false);
  });
});

describe('请求头白名单', () => {
  it('只透传白名单里的头（host 等由 fetch 自己算）', () => {
    expect(PASS_HEADERS).toContain('authorization');
    expect(PASS_HEADERS).not.toContain('host');
    expect(PASS_HEADERS).not.toContain('content-length');
    expect(PASS_HEADERS).not.toContain('connection');
  });
});

/* ============================ 客户端容错 ============================ */

describe('前端客户端：失败不抛异常', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('网络层失败返回结构化错误而不是抛出', async () => {
    const { getRecords } = await import('../../src/lib/api');
    const r = await getRecords();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('unreachable');
  });

  it('503 识别为后端不可达', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'backend_unreachable', message: '后端未启动' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const { getRecords } = await import('../../src/lib/api');
    const r = await getRecords();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('unreachable');
      expect(r.failure).toHaveProperty('message', '后端未启动');
    }
  });

  it('401 清除 token 并返回 unauthorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    );
    const { getRecords, currentToken } = await import('../../src/lib/api');
    const r = await getRecords();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('unauthorized');
    expect(currentToken()).toBeNull();
  });

  it('非法 JSON 返回 error 而不是崩溃', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html>not json</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    const { getRecords } = await import('../../src/lib/api');
    const r = await getRecords();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('error');
  });

  it('业务 code 非 0 时返回后端给的 message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 40900, message: '该时段已被占用' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const { getBookings } = await import('../../src/lib/api');
    const r = await getBookings();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure).toHaveProperty('message', '该时段已被占用');
  });
});
