/* ------------------------------------------------------------------
 * 院方工具层测试（MCP 形状）
 *
 * 这一层的价值在于「三态结果」和「schema 形状」，
 * 所以测试也围绕这两点：
 *   · empty 与 error 必须分开 —— 混成一种，用户会以为没号是网络故障
 *   · schema 必须能在不改成自定义字段的前提下喂给 MCP 客户端
 * ------------------------------------------------------------------ */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOSPITAL_TOOLS,
  getTool,
  holdSlot,
  listHospitals,
  listSlots,
  toolManifest,
} from './mcp-hospital';

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ============================ schema 形状 ============================ */

describe('工具 schema 对齐 MCP', () => {
  it('每个工具都有 name / description / inputSchema / handler', () => {
    for (const t of HOSPITAL_TOOLS) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema.type).toBe('object');
      expect(Array.isArray(t.inputSchema.required)).toBe(true);
      expect(typeof t.handler).toBe('function');
    }
  });

  it('toolManifest 输出可以直接当 MCP tools/list 的结果', () => {
    const m = toolManifest();
    expect(m).toHaveLength(HOSPITAL_TOOLS.length);
    for (const t of m) {
      // 不包含 handler —— 清单只描述能力，不暴露实现
      expect(t).not.toHaveProperty('handler');
      expect(Object.keys(t).sort()).toEqual(['description', 'inputSchema', 'name']);
    }
  });

  it('工具名与 docs/05 的清单一致', () => {
    const names = HOSPITAL_TOOLS.map((t) => t.name);
    expect(names).toContain('list_slots');
    expect(names).toContain('hold_slot');
  });

  it('getTool 按名字取，取不到返回 undefined', () => {
    expect(getTool('list_slots')?.name).toBe('list_slots');
    expect(getTool('nope')).toBeUndefined();
  });

  it('必填参数被正确声明', () => {
    expect(listSlots.inputSchema.required).toEqual(['hospitalCode', 'department', 'date']);
    expect(holdSlot.inputSchema.required).toEqual([
      'hospitalCode',
      'department',
      'visitTime',
      'token',
    ]);
  });
});

/* ============================ 三态结果 ============================ */

describe('listSlots：三态必须分开', () => {
  it('有号 → ok', async () => {
    mockFetch(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: [{ visitTime: '2026-11-16T08:30:00', doctorName: 'A', remaining: 1 }],
        }),
        { status: 200 },
      ),
    );
    const r = await listSlots.handler({ hospitalCode: 'MOCK-A', department: '内分泌科', date: '2026-11-16' });
    expect(r.status).toBe('ok');
  });

  it('号源为空数组 → empty（不是 error）', async () => {
    mockFetch(async () => new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 }));
    const r = await listSlots.handler({ hospitalCode: 'MOCK-A', department: '内分泌科', date: '2026-11-16' });
    // 关键：没号是正常业务状态，不该让用户以为系统坏了
    expect(r.status).toBe('empty');
  });

  it('后端连不上 → error/unreachable', async () => {
    mockFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const r = await listSlots.handler({ hospitalCode: 'MOCK-A', department: '内分泌科', date: '2026-11-16' });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.reason).toBe('unreachable');
  });

  it('400（科室不存在）→ error/not_found', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ message: '院区不存在或暂未接入' }), { status: 400 }),
    );
    const r = await listSlots.handler({ hospitalCode: 'MOCK-Z', department: '内分泌科', date: '2026-11-16' });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.reason).toBe('not_found');
  });

  it('401 → error/unauthorized', async () => {
    mockFetch(async () => new Response('', { status: 401 }));
    const r = await listSlots.handler({ hospitalCode: 'MOCK-A', department: '内分泌科', date: '2026-11-16' });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.reason).toBe('unauthorized');
  });

  it('非法 JSON → error 而不是崩溃', async () => {
    mockFetch(async () => new Response('<html>', { status: 200 }));
    const r = await listSlots.handler({ hospitalCode: 'MOCK-A', department: '内分泌科', date: '2026-11-16' });
    expect(r.status).toBe('error');
  });

  it('业务 code 非 0 → error', async () => {
    mockFetch(async () => new Response(JSON.stringify({ code: 50000, message: '内部错误' }), { status: 200 }));
    const r = await listSlots.handler({ hospitalCode: 'MOCK-A', department: '内分泌科', date: '2026-11-16' });
    expect(r.status).toBe('error');
  });
});

describe('holdSlot：写操作', () => {
  it('带 token 下单成功 → ok', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ code: 0, data: { id: 1, externalOrderNo: 'MOCK-A-1001' } }), {
        status: 200,
      }),
    );
    const r = await holdSlot.handler({
      hospitalCode: 'MOCK-A',
      department: '内分泌科',
      visitTime: '2026-11-16T08:30:00',
      token: 't',
    });
    expect(r.status).toBe('ok');
  });

  it('409（号被占）→ error/rejected，带上院方原因', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ message: '该时段已被占用' }), { status: 409 }),
    );
    const r = await holdSlot.handler({
      hospitalCode: 'MOCK-A',
      department: '内分泌科',
      visitTime: '2026-11-16T08:30:00',
      token: 't',
    });
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.reason).toBe('rejected');
      expect(r.detail).toContain('已被占用');
    }
  });

  it('没有 token 时后端 401 → unauthorized', async () => {
    mockFetch(async () => new Response('', { status: 401 }));
    const r = await holdSlot.handler({
      hospitalCode: 'MOCK-A',
      department: '内分泌科',
      visitTime: '2026-11-16T08:30:00',
      token: '',
    });
    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.reason).toBe('unauthorized');
  });
});

describe('listHospitals', () => {
  it('返回院区列表', async () => {
    mockFetch(async () => new Response(JSON.stringify({ code: 0, data: ['MOCK-A', 'MOCK-B'] }), { status: 200 }));
    const r = await listHospitals.handler({});
    expect(r.status).toBe('ok');
  });

  it('空列表 → empty', async () => {
    mockFetch(async () => new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 }));
    const r = await listHospitals.handler({});
    expect(r.status).toBe('empty');
  });
});
