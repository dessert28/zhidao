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
import { extractJson, normalizeItems } from './recognize';

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
    const { recognizeLabImage } = await import('./recognize');
    const r = await recognizeLabImage(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unconfigured');
    expect(spy).not.toHaveBeenCalled();
  });

  it('不支持的格式 → unsupported', async () => {
    process.env.LLM_API_KEY = 'k';
    const { recognizeLabImage } = await import('./recognize');
    const r = await recognizeLabImage({ ...input, mimeType: 'image/gif' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unsupported');
  });

  it('超尺寸图片 → unsupported', async () => {
    process.env.LLM_API_KEY = 'k';
    const { recognizeLabImage } = await import('./recognize');
    const r = await recognizeLabImage({ ...input, byteSize: 5 * 1024 * 1024 });
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
    const { recognizeLabImage } = await import('./recognize');
    const r = await recognizeLabImage(input);
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
    const { recognizeLabImage } = await import('./recognize');
    const r = await recognizeLabImage(input);
    // 关键：空结果不能当成成功 —— 用户会以为处理完了
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/没能|手动录入/);
  });

  it('模型 401 → 提示密钥失效', async () => {
    process.env.LLM_API_KEY = 'k';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    const { recognizeLabImage } = await import('./recognize');
    const r = await recognizeLabImage(input);
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
    const { recognizeLabImage } = await import('./recognize');
    const r = await recognizeLabImage(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/超时|压缩/);
  });
});
