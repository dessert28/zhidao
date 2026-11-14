/* ------------------------------------------------------------------
 * PDF 文本提取测试
 *
 * 真实 PDF 由 pdfjs 在浏览器环境解析，jsdom 里跑不了完整的 worker。
 * 所以这里测的是**判定逻辑**（扫描件 vs 文本型 vs 损坏），
 * 用 mock 替换 pdfjs 模块 —— 这恰恰是最容易出错、也最该被测的部分：
 *
 *   判定太松 → 扫描件被当成文本型，用户拿到空病历却显示"成功"
 *   判定太严 → 正常的文字版 PDF 被拒，功能形同虚设
 * ------------------------------------------------------------------ */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 用 mock 替换 pdfjs，模拟三种 PDF 的抽取结果 */
let mockPages: Array<{ items: Array<{ str: string; hasEOL?: boolean }> }> = [];
let mockShouldThrow: string | null = null;

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: (async () => {
      if (mockShouldThrow) throw new Error(mockShouldThrow);
      return {
        numPages: mockPages.length,
        getPage: async (i: number) => ({
          getTextContent: async () => ({ items: mockPages[i - 1]!.items }),
          cleanup: () => {},
        }),
      };
    })(),
    destroy: async () => {},
  }),
}));

/** 构造一个假 File */
function pdfFile(name = 'report.pdf'): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
    type: 'application/pdf',
  });
}

beforeEach(() => {
  mockPages = [];
  mockShouldThrow = null;
  vi.resetModules();
});

describe('文本型 PDF', () => {
  it('能抽取文字并保留换行', async () => {
    mockPages = [
      {
        items: [
          { str: '患者：张伟', hasEOL: true },
          { str: '空腹血糖 8.4 mmol/L', hasEOL: true },
          { str: '建议三个月后复查', hasEOL: true },
        ],
      },
    ];
    const { extractPdfText } = await import('./pdf');
    const r = await extractPdfText(pdfFile());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('空腹血糖 8.4');
      expect(r.text).toContain('\n'); // 换行被保留
      expect(r.pageCount).toBe(1);
    }
  });

  it('多页内容都抽到', async () => {
    mockPages = [
      { items: [{ str: '第一页内容，这里是检验结果的一部分。', hasEOL: true }] },
      { items: [{ str: '第二页内容，这里是医嘱建议的部分。', hasEOL: true }] },
    ];
    const { extractPdfText } = await import('./pdf');
    const r = await extractPdfText(pdfFile());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('第一页');
      expect(r.text).toContain('第二页');
      expect(r.pageCount).toBe(2);
    }
  });
});

describe('扫描件判定（最容易出错的地方）', () => {
  it('完全没有文字 → 判为扫描件', async () => {
    mockPages = [{ items: [] }];
    const { extractPdfText } = await import('./pdf');
    const r = await extractPdfText(pdfFile());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('scanned');
      // 必须告诉用户该怎么办，不能只说"失败"
      expect(r.message).toMatch(/扫描件|手动录入/);
    }
  });

  it('每页只有零星几个字（水印）→ 也判为扫描件', async () => {
    // 每页 3 个字，低于阈值 10
    mockPages = [
      { items: [{ str: '扫描', hasEOL: true }] },
      { items: [{ str: '件页', hasEOL: true }] },
    ];
    const { extractPdfText } = await import('./pdf');
    const r = await extractPdfText(pdfFile());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('scanned');
  });

  it('每页刚好达到阈值 → 当作文本型', async () => {
    // 每页 12 个字，超过 10 的阈值
    mockPages = [{ items: [{ str: '一二三四五六七八九十十一十二', hasEOL: true }] }];
    const { extractPdfText } = await import('./pdf');
    const r = await extractPdfText(pdfFile());
    expect(r.ok).toBe(true);
  });
});

describe('损坏与加密', () => {
  it('解析抛错 → broken，不崩', async () => {
    mockShouldThrow = 'Invalid PDF structure';
    const { extractPdfText } = await import('./pdf');
    const r = await extractPdfText(pdfFile());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('broken');
  });

  it('加密 PDF → 给专门的引导话术', async () => {
    mockShouldThrow = 'No password given';
    const { extractPdfText } = await import('./pdf');
    const r = await extractPdfText(pdfFile());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('broken');
      // 加密是常见原因，话术要能指导用户
      expect(r.message).toMatch(/密码/);
    }
  });
});
