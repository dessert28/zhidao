/* ------------------------------------------------------------------
 * 病历上传测试 —— 隐私边界是这里最该测的东西
 *
 * 三个断言值得单独说明：
 *
 * 1. **原文不得出现在网络请求里**
 *    这条测的不是"功能对不对"，是"隐私架构有没有被破坏"。
 *    用 spy 拦下 fetch，断言请求体里搜不到原文片段。
 *
 * 2. **原文必须进了本地存储**
 *    否则"原文留在本机"这句承诺是空的。
 *
 * 3. **不支持的格式明确拒绝**
 *    PDF 不做"读出乱码当成功"，那会让患者以为处理完了。
 * ------------------------------------------------------------------ */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 内存版 IndexedDB 替身：只实现本模块用到的几个方法 */
const memStore = new Map<string, unknown>();

vi.mock('idb', () => ({
  openDB: async () => ({
    put: async (_store: string, value: { id: string }) => {
      memStore.set(value.id, value);
      return value.id;
    },
    getAllFromIndex: async () => [...memStore.values()],
    get: async (_store: string, id: string) => memStore.get(id),
    delete: async (_store: string, id: string) => {
      memStore.delete(id);
    },
    clear: async () => {
      memStore.clear();
    },
  }),
}));

const RAW = `患者：张伟，身份证 110101199003071234，手机 13812345678。
主诉：血糖控制不佳三个月。空腹血糖 8.4 mmol/L。`;

/** 构造一个 File（jsdom 有 File 实现） */
function makeFile(content: string, name = '化验单.txt'): File {
  return new File([content], name, { type: 'text/plain' });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  memStore.clear();
  fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ code: 0, data: { id: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  vi.resetModules();
});

describe('上传：隐私边界', () => {
  it('原文进了本地存储', async () => {
    const { uploadRecord } = await import('./upload');
    const r = await uploadRecord({
      file: makeFile(RAW),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });

    expect(r.ok).toBe(true);
    const stored = [...memStore.values()] as Array<{ rawText: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.rawText).toBe(RAW);
  });

  it('**网络请求里不含原文的任何个人信息**', async () => {
    const { uploadRecord } = await import('./upload');
    await uploadRecord({
      file: makeFile(RAW),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });

    // 找出真正发出去的请求体
    const bodies = fetchSpy.mock.calls
      .map((c) => (c[1] as RequestInit | undefined)?.body)
      .filter((b): b is string => typeof b === 'string');

    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;

    // 这三样是敏感信息，一个都不能出现在请求体里
    expect(body, '姓名泄漏').not.toContain('张伟');
    expect(body, '身份证泄漏').not.toContain('110101199003071234');
    expect(body, '手机号泄漏').not.toContain('13812345678');

    // 但医疗内容要保留 —— 不然上传就没意义了
    expect(body).toContain('血糖');
  });

  it('返回结果里报告遮蔽了几处', async () => {
    const { uploadRecord } = await import('./upload');
    const r = await uploadRecord({
      file: makeFile(RAW),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.maskedCount).toBeGreaterThan(0);
  });
});

describe('上传：不支持的输入', () => {
  it('PDF 明确拒绝，不假装处理成功', async () => {
    const { uploadRecord } = await import('./upload');
    const r = await uploadRecord({
      file: new File(['%PDF-1.4'], 'report.pdf', { type: 'application/pdf' }),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe('unsupported');
      expect(r.message).toContain('暂不支持');
    }
    // 拒绝了就不该有任何网络请求
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('空文件被拒', async () => {
    const { uploadRecord } = await import('./upload');
    const r = await uploadRecord({
      file: makeFile('   '),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe('read');
  });

  it('.md 文件可以上传', async () => {
    const { uploadRecord } = await import('./upload');
    const r = await uploadRecord({
      file: makeFile('# 就诊记录\n血糖偏高', 'note.md'),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });
    expect(r.ok).toBe(true);
  });
});

describe('上传：后端失败时不丢数据', () => {
  it('后端不可达 → 明确说"原文已存本地"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    const { uploadRecord } = await import('./upload');
    const r = await uploadRecord({
      file: makeFile(RAW),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe('backend');
      // 关键：患者要知道数据没丢
      expect(r.message).toContain('原文已保存在本机');
    }
    // 原文仍然在本地
    expect(memStore.size).toBe(1);
  });

  it('后端 503 时同样保留本地原文', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'backend_unreachable' }), { status: 503 })),
    );
    const { uploadRecord } = await import('./upload');
    const r = await uploadRecord({
      file: makeFile(RAW),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe('backend');
    expect(memStore.size).toBe(1);
  });
});
