import { describe, expect, it } from 'vitest';
import { interpretReport, splitSentences, hasInterpretation } from './interpret';
import { parseReport } from './reports';

const CT_TEXT = `胸部 CT 平扫
检查所见：
双肺纹理清晰，左肺上叶见磨玻璃结节，直径约 4mm。双侧胸膜腔未见积液。
检查结论：
1. 左肺上叶磨玻璃结节，建议 3-6 个月复查。`;

describe('splitSentences', () => {
  it('按句号与分号切分，并去掉条目编号', () => {
    expect(splitSentences('1. 双肺纹理清晰。2、左肺见结节；右肺清晰')).toEqual([
      '双肺纹理清晰。',
      '左肺见结节；',
      '右肺清晰',
    ]);
  });

  it('换行也当成断句', () => {
    expect(splitSentences('第一行\n第二行')).toEqual(['第一行', '第二行']);
  });

  it('丢掉过短的碎片', () => {
    expect(splitSentences('无。')).toEqual([]);
  });
});

describe('interpretReport', () => {
  it('影像报告：抽出结论与所见，并给出术语注解', () => {
    const parsed = parseReport(CT_TEXT);
    const r = interpretReport(CT_TEXT, undefined, parsed);

    expect(r.kind).toBe('CT');
    expect(r.title).toBe('胸部CT');
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.terms.map((t) => t.term)).toContain('磨玻璃密度影');
    expect(r.caveat).toContain('不涉及对结果的判断');
  });

  it('术语注解按出现顺序排列，且不重复', () => {
    const r = interpretReport(CT_TEXT);
    const names = r.terms.map((t) => t.term);
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toBe('肺纹理');
  });

  it('病理报告用更严格的脚注', () => {
    const text = '病理诊断：\n（胃窦）黏膜慢性炎，伴轻度不典型增生。';
    const r = interpretReport(text);
    expect(r.kind).toBe('PATHOLOGY');
    expect(r.caveat).toContain('病理科医生');
    expect(r.terms.map((t) => t.term)).toContain('不典型增生');
  });

  it('化验单没有段落时退回扫全文，脚注说明对照的是报告自带范围', () => {
    const text = '血常规\n白细胞计数 6.2 参考范围 3.5-9.5\n中性粒细胞百分比 阴性';
    const r = interpretReport(text);
    expect(r.kind).toBe('LAB');
    expect(r.title).toBe('化验单');
    expect(r.lines).toEqual([]);
    expect(r.terms.map((t) => t.term)).toContain('参考范围');
    expect(r.caveat).toContain('参考范围');
    expect(r.caveat).not.toContain('健康管家');
  });

  it('没有可读文字时给出一句说明而不是空白', () => {
    const r = interpretReport('');
    expect(r.terms).toEqual([]);
    expect(r.emptyReason).toContain('没有可读的文字');
  });

  it('术语一个都没命中时说明原因', () => {
    const r = interpretReport('检查结论：未见明显异常。');
    expect(r.terms).toEqual([]);
    expect(r.emptyReason).toContain('没有需要注解的专业术语');
  });
});

describe('hasInterpretation', () => {
  it('有术语才显示', () => {
    const text = '检查结论：左肺结节。';
    expect(hasInterpretation(interpretReport(text), true)).toBe(true);
  });

  it('门诊病历（无报告段落、无术语）不占位置', () => {
    const text = '主诉：咳嗽三天。现病史：患者三天前受凉后出现咳嗽。';
    expect(hasInterpretation(interpretReport(text), true)).toBe(false);
  });

  it('没有文本直接 false', () => {
    expect(hasInterpretation(interpretReport(''), false)).toBe(false);
  });
});
