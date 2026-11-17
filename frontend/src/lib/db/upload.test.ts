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

  it('**网络请求里不含原文的证件号与手机号**', async () => {
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

    // 这两样一个都不能出现在请求体里
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
  it('未知格式（如 .docx）明确拒绝', async () => {
    const { uploadRecord } = await import('./upload');
    const r = await uploadRecord({
      file: new File(['PK'], 'record.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
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

  it('未知图片格式（如 gif）被识别模块拒绝', async () => {
    /*
     * 图片现在支持了（PNG/JPG/WebP），但 gif 不在支持列表。
     * 拒绝发生在 ocr 封装层，话术是"暂不支持这种格式"。
     */
    const { uploadRecord } = await import('./upload');
    const r = await uploadRecord({
      file: new File(['GIF89a'], 'scan.gif', { type: 'image/gif' }),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe('unsupported');
  });

  it('假的 PDF（内容非法）走解析失败，而不是"格式不支持"', async () => {
    /*
     * PDF 现在已经支持了 —— 一份内容是乱码的 .pdf 应当报"解析失败"，
     * 而不是"暂不支持这种格式"。
     * 两者的用户指引不同：前者让用户检查文件，后者让用户换格式。
     */
    const { uploadRecord } = await import('./upload');
    const r = await uploadRecord({
      file: new File(['%PDF-1.4 not really a pdf'], 'report.pdf', { type: 'application/pdf' }),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe('unsupported');
      // 话术应该是"解析失败/损坏"，不是"暂不支持这种格式"
      expect(r.message).toMatch(/解析失败|损坏/);
    }
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

/* ------------------------------------------------------------------
 * 两阶段上传：患者先校对，再提交
 *
 * 最关键的一组断言是"prepare 阶段零副作用"：
 * 患者还没点确认时，既不能落库，也不能发请求。
 * 否则「取消」就变成了"以为取消了，其实已经传了"。
 * ------------------------------------------------------------------ */

/** 取出所有 POST 请求体 */
function sentBodies(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls
    .map((c) => (c[1] as RequestInit | undefined)?.body)
    .filter((b): b is string => typeof b === 'string');
}

describe('两阶段上传：prepare 只出草稿', () => {
  it('不落库、不调用后端，摘要已经脱敏', async () => {
    const { prepareUpload } = await import('./upload');
    const r = await prepareUpload({
      file: makeFile(RAW),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.draft.diagnosisBrief).toContain('血糖');
      expect(r.draft.diagnosisBrief).not.toContain('110101199003071234');
      expect(r.draft.diagnosisBrief).not.toContain('13812345678');
    }

    // 零副作用
    expect(memStore.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('检查单的草稿带出可编辑的检查项目', async () => {
    const { prepareUpload } = await import('./upload');
    const r = await prepareUpload({
      file: makeFile('检查项目：\n胸部 CT 平扫\n血常规'),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
      kind: 'examOrder',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      // 词典命中返回标准名（「胸部 CT 平扫」→「胸部CT」），原文仍在 evidence
      expect(r.draft.examItems.map((i) => i.name)).toEqual(
        expect.arrayContaining(['胸部CT', '血常规']),
      );
    }
    expect(memStore.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('不支持的格式在 prepare 阶段就拒绝，且没有副作用', async () => {
    const { prepareUpload } = await import('./upload');
    const r = await prepareUpload({
      file: new File(['PK'], 'record.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stage).toBe('unsupported');
    expect(memStore.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('两阶段上传：confirm 才落库并提交', () => {
  it('原文完整存本地，请求体用编辑后的摘要且不含 PII', async () => {
    const { prepareUpload, confirmUpload } = await import('./upload');
    const input = {
      file: makeFile(RAW),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    };

    const p = await prepareUpload(input);
    expect(p.ok).toBe(true);
    if (!p.ok) return;

    const r = await confirmUpload(input, {
      ...p.draft,
      diagnosisBrief: '复查血糖，按期复诊',
    });
    expect(r.ok).toBe(true);

    // ① 原文仍然完整留在本地
    const stored = [...memStore.values()] as Array<{ rawText: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.rawText).toBe(RAW);

    // ③ 只发一次，且发出去的是脱敏文本
    const bodies = sentBodies(fetchSpy);
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body).toContain('复查血糖');
    // ocrText 仍来自原文，而不是患者改过的摘要
    expect(body).toContain('血糖控制不佳');
    expect(body, '身份证泄漏').not.toContain('110101199003071234');
    expect(body, '手机号泄漏').not.toContain('13812345678');
  });

  it('检查项目保存的是患者改过/删过的版本', async () => {
    const { prepareUpload, confirmUpload } = await import('./upload');
    const input = {
      file: makeFile('检查项目：\n胸部 CT 平扫\n血常规'),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
      kind: 'examOrder' as const,
    };

    const p = await prepareUpload(input);
    expect(p.ok).toBe(true);
    if (!p.ok) return;

    // 患者把 CT 改了名，并删掉了血常规
    const r = await confirmUpload(input, {
      ...p.draft,
      examItems: [
        {
          name: '胸部 CT（平扫）',
          placeType: 'EXAM',
          fasting: null,
          evidence: '胸部 CT 平扫',
        },
      ],
    });
    expect(r.ok).toBe(true);

    const stored = [...memStore.values()] as Array<{
      examItems?: Array<{ name: string }>;
    }>;
    expect(stored[0]!.examItems?.map((i) => i.name)).toEqual(['胸部 CT（平扫）']);
  });

  it('患者把摘要清空时如实提交空摘要，不偷偷塞回原文', async () => {
    const { prepareUpload, confirmUpload } = await import('./upload');
    const input = {
      file: makeFile(RAW),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    };

    const p = await prepareUpload(input);
    if (!p.ok) return;

    const r = await confirmUpload(input, { ...p.draft, diagnosisBrief: '' });
    expect(r.ok).toBe(true);

    const body = sentBodies(fetchSpy)[0]!;
    const payload = JSON.parse(body) as { diagnosisBrief: string };
    expect(payload.diagnosisBrief).toBe('');
  });
});

describe('两阶段上传：取消路径', () => {
  it('只 prepare 不 confirm —— 没有任何落库或提交', async () => {
    const { prepareUpload } = await import('./upload');
    const r = await prepareUpload({
      file: makeFile(RAW),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });
    expect(r.ok).toBe(true);

    // 用户点了「取消」：后面什么都不调用
    expect(memStore.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('两阶段上传：uploadRecord 兼容', () => {
  it('仍是 prepare + confirm 的组合，结果结构不变', async () => {
    const { uploadRecord } = await import('./upload');
    const r = await uploadRecord({
      file: makeFile(RAW),
      visitDate: '2026-11-01',
      hospitalCode: 'MOCK-A',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.localId).toBe('string');
      expect(r.redactedLength).toBeGreaterThan(0);
      expect(r.maskedCount).toBeGreaterThan(0);
    }
    expect(memStore.size).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
