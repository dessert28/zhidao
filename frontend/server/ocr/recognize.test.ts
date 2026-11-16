/* ------------------------------------------------------------------
 * 报告图识别测试
 *
 * 三块：
 *   1. JSON 提取 —— 模型经常把 JSON 包在 ```json 里，直接 parse 会失败
 *   2. 条目清洗 —— 模型会编造空行、超量条目、非字符串字段
 *   3. 识别主流程 —— mock fetch，验证各类失败给不同话术
 *
 * 隐私相关的断言在 routes/ocr 的出关口，这里测不到，
 * 那个由集成测试（server/routes/ocr 层面）保证。
 * ------------------------------------------------------------------ */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOcrText, extractJson, normalizeItems, normalizeKind } from './recognize';

describe('JSON 提取', () => {
  it('裸 JSON 直接解析', () => {
    expect(extractJson('{"items":[{"name":"血糖","value":"8.4"}]}')).toEqual({
      items: [{ name: '血糖', value: '8.4' }],
    });
  });

  it('```json 代码块里的 JSON 能抠出来', () => {
    const text = '```json\n{"items":[{"name":"血糖","value":"8.4"}]}\n```';
    expect(extractJson(text)).toEqual({ items: [{ name: '血糖', value: '8.4' }] });
  });

  it('前后带解释文字也能抠出来', () => {
    const text = '好的，识别结果如下：{"items":[{"name":"血糖","value":"8.4"}]} 希望对你有帮助。';
    expect(extractJson(text)).toEqual({ items: [{ name: '血糖', value: '8.4' }] });
  });

  it('没有 JSON 时返回 null，不抛异常', () => {
    expect(extractJson('抱歉，我看不清这张图')).toBeNull();
    expect(extractJson('')).toBeNull();
  });

  it('残缺 JSON 返回 null', () => {
    expect(extractJson('{"items":[{"name":"血糖"')).toBeNull();
  });
});

describe('条目清洗', () => {
  it('正常条目原样保留', () => {
    expect(
      normalizeItems({
        items: [
          { name: '空腹血糖', value: '8.4 mmol/L', reference: '3.9-6.1' },
          { name: '糖化血红蛋白', value: '7.8%' },
        ],
      }),
    ).toEqual([
      { name: '空腹血糖', value: '8.4 mmol/L', reference: '3.9-6.1' },
      { name: '糖化血红蛋白', value: '7.8%' },
    ]);
  });

  it('丢弃全空条目（模型偶尔吐空行）', () => {
    const r = normalizeItems({ items: [{ name: '', value: '' }, { name: '血糖', value: '8.4' }] });
    expect(r).toHaveLength(1);
  });

  it('没有 items 字段时返回空数组', () => {
    expect(normalizeItems({})).toEqual([]);
    expect(normalizeItems(null)).toEqual([]);
    expect(normalizeItems({ items: 'not an array' })).toEqual([]);
  });

  it('非字符串字段被忽略而不是崩溃', () => {
    const r = normalizeItems({ items: [{ name: 123, value: { a: 1 } }] });
    expect(r).toEqual([]);
  });

  it('超过 30 条时截断（防模型编造）', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `项目${i}`, value: String(i) }));
    expect(normalizeItems({ items: many })).toHaveLength(30);
  });

  it('空白 reference 不带上（避免出现 "参考 " 这种空标签）', () => {
    const r = normalizeItems({ items: [{ name: '血糖', value: '8.4', reference: '   ' }] });
    expect(r[0]).not.toHaveProperty('reference');
  });
});

describe('识别主流程', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.LLM_API_KEY;
  });

  const input = { base64: 'AAAA', mimeType: 'image/png', byteSize: 100 };

  it('未配置模型 → unconfigured，不发起请求', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    delete process.env.LLM_API_KEY;
    const { recognizeReportImage } = await import('./recognize');
    const r = await recognizeReportImage(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unconfigured');
    expect(spy).not.toHaveBeenCalled();
  });

  it('不支持的格式 → unsupported', async () => {
    process.env.LLM_API_KEY = 'k';
    const { recognizeReportImage } = await import('./recognize');
    const r = await recognizeReportImage({ ...input, mimeType: 'image/gif' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsupported');
  });

  it('超尺寸图片 → unsupported', async () => {
    process.env.LLM_API_KEY = 'k';
    const { recognizeReportImage } = await import('./recognize');
    const r = await recognizeReportImage({ ...input, byteSize: 5 * 1024 * 1024 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsupported');
  });

  it('识别成功 → 返回条目与拼回的文本', async () => {
    process.env.LLM_API_KEY = 'k';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '```json\n{"items":[{"name":"空腹血糖","value":"8.4 mmol/L"},{"name":"HbA1c","value":"7.8%"}]}\n```',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const { recognizeReportImage } = await import('./recognize');
    const r = await recognizeReportImage(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items).toHaveLength(2);
      expect(r.rawText).toContain('空腹血糖');
      expect(r.rawText).toContain('8.4');
    }
  });

  it('识别出 0 项 → 报失败而不是空成功', async () => {
    process.env.LLM_API_KEY = 'k';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const { recognizeReportImage } = await import('./recognize');
    const r = await recognizeReportImage(input);
    // 关键：空结果不能当成成功 —— 用户会以为处理完了
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/没能|手动录入/);
  });

  it('模型 401 → 提示密钥失效', async () => {
    process.env.LLM_API_KEY = 'k';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    const { recognizeReportImage } = await import('./recognize');
    const r = await recognizeReportImage(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/密钥/);
  });

  it('网络超时 → 给可操作的建议', async () => {
    process.env.LLM_API_KEY = 'k';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('The operation was aborted due to timeout');
      }),
    );
    const { recognizeReportImage } = await import('./recognize');
    const r = await recognizeReportImage(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/超时|压缩/);
  });
});

/* ============================================================
 * 影像 / 心电报告
 *
 * 这些报告没有「项目 + 数值」结构，第一版 OCR 会把它们全判成失败。
 * 下面这组用例守的就是「不是化验单也能读」。
 * ============================================================ */

describe('类型识别', () => {
  it('标准枚举直接通过', () => {
    expect(normalizeKind({ kind: 'CT' })).toBe('CT');
    expect(normalizeKind({ kind: 'ultrasound' })).toBe('ULTRASOUND');
    expect(normalizeKind({ kind: 'Ecg' })).toBe('ECG');
  });

  it('模型返回中文也能映射', () => {
    expect(normalizeKind({ kind: '胸部CT' })).toBe('CT');
    expect(normalizeKind({ kind: '腹部彩超' })).toBe('ULTRASOUND');
    expect(normalizeKind({ kind: '心电图' })).toBe('ECG');
    expect(normalizeKind({ kind: 'X线' })).toBe('XRAY');
    expect(normalizeKind({ kind: '胃镜' })).toBe('ENDOSCOPY');
    expect(normalizeKind({ kind: '化验单' })).toBe('LAB');
  });

  it('乱七八糟的值收敛成 OTHER，不崩', () => {
    expect(normalizeKind(null)).toBe('OTHER');
    expect(normalizeKind({})).toBe('OTHER');
    expect(normalizeKind({ kind: 123 })).toBe('OTHER');
    expect(normalizeKind({ kind: '完全不懂' })).toBe('OTHER');
  });
});

describe('规范文本拼接', () => {
  it('顺序必须是 名称 → 所见 → 结论', () => {
    /*
     * 下游 reports.ts 用「所见…后接结论标记」切段。
     * 如果把结论放前面，切分就会错位，界面上所见和结论会串。
     */
    const text = buildOcrText({
      title: '胸部 CT 平扫',
      findings: '右肺上叶见一磨玻璃结节，直径约 4mm。',
      conclusion: '1. 右肺上叶磨玻璃结节，建议 6-12 个月复查',
      items: [],
      params: [],
    });
    expect(text.indexOf('检查名称')).toBeLessThan(text.indexOf('检查所见'));
    expect(text.indexOf('检查所见')).toBeLessThan(text.indexOf('检查结论'));
  });

  it('化验单：数值逐行铺开', () => {
    const text = buildOcrText({
      title: '生化',
      findings: null,
      conclusion: null,
      items: [
        { name: '空腹血糖', value: '8.4 mmol/L', reference: '3.9-6.1' },
        { name: '糖化血红蛋白', value: '7.8%' },
      ],
      params: [],
    });
    expect(text).toContain('空腹血糖 8.4 mmol/L');
    expect(text).toContain('参考范围 3.9-6.1');
    expect(text).toContain('糖化血红蛋白 7.8%');
  });

  it('空字段不产生空标题行', () => {
    const text = buildOcrText({
      title: null,
      findings: null,
      conclusion: '窦性心律',
      items: [],
      params: [],
    });
    expect(text).not.toContain('检查所见：null');
    expect(text).not.toContain('检查名称：');
    expect(text).toContain('检查结论：窦性心律');
  });
});

describe('影像与心电报告识别', () => {
  const input = { base64: 'AAAA', mimeType: 'image/png', byteSize: 100 };

  const mockLlm = (payload: unknown) => {
    process.env.LLM_API_KEY = 'k';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  };

  it('CT 报告：没有 items 也算识别成功', async () => {
    mockLlm({
      kind: 'CT',
      title: '胸部 CT 平扫',
      findings: '双侧胸廓对称。右肺上叶见一磨玻璃结节，直径约 4mm。',
      conclusion: '右肺上叶磨玻璃结节，建议 6-12 个月复查。',
      items: [],
      params: [],
    });
    const { recognizeReportImage } = await import('./recognize');
    const r = await recognizeReportImage(input);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe('CT');
      expect(r.conclusion).toContain('磨玻璃结节');
      expect(r.rawText).toContain('检查所见');
      expect(r.rawText).toContain('检查结论');
    }
  });

  it('心电图：params 被抽出并写入文本', async () => {
    mockLlm({
      kind: 'ECG',
      title: '十二导联心电图',
      findings: '窦性心律。ST 段无明显偏移。',
      conclusion: '窦性心律，大致正常心电图。',
      items: [],
      params: [
        { name: '心率', value: '72 次/分' },
        { name: 'PR 间期', value: '160 ms' },
      ],
    });
    const { recognizeReportImage } = await import('./recognize');
    const r = await recognizeReportImage(input);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe('ECG');
      expect(r.params).toHaveLength(2);
      expect(r.rawText).toContain('心率 72 次/分');
    }
  });

  it('X 线报告：只有 findings 也能成功', async () => {
    mockLlm({
      kind: 'XRAY',
      title: '胸部正位片',
      findings: '两肺纹理清晰，未见明显实质性病变。',
      items: [],
      params: [],
    });
    const { recognizeReportImage } = await import('./recognize');
    const r = await recognizeReportImage(input);
    expect(r.ok).toBe(true);
  });

  it('全是空内容 → 仍判失败，不假装成功', async () => {
    mockLlm({ kind: 'OTHER', items: [], params: [], findings: '', conclusion: '' });
    const { recognizeReportImage } = await import('./recognize');
    const r = await recognizeReportImage(input);
    expect(r.ok).toBe(false);
  });

  it('模型编造超长结论时截断，不无限膨胀', async () => {
    mockLlm({
      kind: 'CT',
      conclusion: '建议复查'.repeat(1000),
      items: [],
      params: [],
    });
    const { recognizeReportImage } = await import('./recognize');
    const r = await recognizeReportImage(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // strField 上限 1200 字符
      expect(r.conclusion!.length).toBeLessThanOrEqual(1200);
    }
  });
});
