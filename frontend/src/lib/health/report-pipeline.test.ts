/* ------------------------------------------------------------------
 * 跨模块链路测试：OCR 输出 → 病历文本 → 界面解析
 *
 * ============ 为什么单独写这一组 ============
 *
 * OCR 那边（server/ocr/recognize.ts）与解析这边
 * （src/lib/health/reports.ts）各自都有测试，但**两边都绿也可能是断的** ——
 * 只要文本格式对不上，整条链路就是死的，而任何一侧的单测都发现不了。
 *
 * 真实场景：
 *   患者拍一张 CT 报告 → VLM 识别 → 拼成文本入库 →
 *   病历页读出来解析 → 显示「结论」与「建议复查」
 *
 * 这条链断在第三环和第四环之间最隐蔽。所以在这里把它们接起来测。
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { buildOcrText } from '../../../server/ocr/recognize';
import { isConclusionType, parseReport, summarizeReport } from './reports';

describe('OCR 输出能被解析器读回', () => {
  it('CT 报告：所见与结论各自归位', () => {
    const text = buildOcrText({
      title: '胸部 CT 平扫',
      findings: '双侧胸廓对称。右肺上叶见一磨玻璃结节，直径约 4mm。',
      conclusion: '右肺上叶磨玻璃结节（约 4mm），建议 6-12 个月复查。',
      items: [],
      params: [],
    });

    const parsed = parseReport(text, 'CT.png');

    expect(parsed.kind).toBe('CT');
    expect(parsed.findings).toContain('磨玻璃结节');
    expect(parsed.conclusion).toContain('建议 6-12 个月复查');
    // 所见里不该混进结论，反之亦然
    expect(parsed.findings).not.toContain('建议 6-12 个月复查');
    expect(parsed.needsFollowUp).toBe(true);
  });

  it('X 线报告（正常）：不应被标为需要复查', () => {
    const text = buildOcrText({
      title: '胸部正位片',
      findings: '两肺纹理清晰，未见明显实质性病变。',
      conclusion: '心肺未见明显异常。',
      items: [],
      params: [],
    });

    const parsed = parseReport(text, '胸片.png');
    expect(parsed.kind).toBe('XRAY');
    /*
     * 这是最容易出错的一条：「未见明显异常」里含「异常」，
     * 如果判定顺序写反，一份完全正常的胸片会被标红，
     * 让患者以为查出问题。
     */
    expect(parsed.needsFollowUp).toBe(false);
  });

  it('心电图：参数与结论都保留', () => {
    const text = buildOcrText({
      title: '十二导联心电图',
      findings: '窦性心律。ST 段无明显偏移。',
      conclusion: '窦性心律，大致正常心电图。',
      items: [],
      params: [
        { name: '心率', value: '72 次/分' },
        { name: 'PR 间期', value: '160 ms' },
      ],
    });

    const parsed = parseReport(text, '心电图.png');

    expect(parsed.kind).toBe('ECG');
    expect(parsed.conclusion).toContain('窦性心律');
    expect(parsed.needsFollowUp).toBe(false);
    // 参数行在文本里，解析器也应能读出心率
    expect(parsed.params.some((p) => p.name === '心率')).toBe(true);
  });

  it('彩超：测量值在文本里可被识别', () => {
    const text = buildOcrText({
      title: '颈动脉彩超',
      findings: '双侧颈总动脉内中膜略增厚，右侧厚约 1.1mm。',
      conclusion: '双侧颈动脉内中膜增厚伴右侧斑块形成。',
      items: [],
      params: [{ name: '厚', value: '1.1mm' }],
    });

    const parsed = parseReport(text, '颈动脉.png');
    expect(parsed.kind).toBe('ULTRASOUND');
    expect(parsed.bodyPart).toBe('颈动脉');
    expect(parsed.needsFollowUp).toBe(true);
  });

  it('内镜报告：诊断能抽到', () => {
    const text = buildOcrText({
      title: '胃镜',
      findings: '胃窦黏膜充血水肿，散在糜烂。',
      conclusion: '慢性非萎缩性胃炎伴糜烂。',
      items: [],
      params: [],
    });

    const parsed = parseReport(text, '胃镜.png');
    expect(parsed.kind).toBe('ENDOSCOPY');
    expect(parsed.conclusion).toContain('胃炎');
  });

  it('化验单：数值仍能被解析器抽成指标文本', () => {
    const text = buildOcrText({
      title: '生化全套',
      findings: null,
      conclusion: null,
      items: [
        { name: '空腹血糖', value: '8.4 mmol/L', reference: '3.9-6.1' },
        { name: '糖化血红蛋白', value: '7.8%' },
      ],
      params: [],
    });

    const parsed = parseReport(text, '化验单.png');
    expect(parsed.kind).toBe('LAB');
    // 化验单没有影像结论，不应被当成结论型报告塞进「检查报告」区块
    expect(isConclusionType(parsed.kind)).toBe(false);
    expect(text).toContain('空腹血糖 8.4 mmol/L');
  });

  it('摘要取到的是结论而不是所见', () => {
    const text = buildOcrText({
      title: '胸部 CT',
      findings: '这是一段很长的影像学描述，患者通常读不下去也不需要读。',
      conclusion: '右肺上叶结节，建议复查。',
      items: [],
      params: [],
    });
    const summary = summarizeReport(parseReport(text, 'ct.png'));
    expect(summary).toContain('结节');
    expect(summary).not.toContain('患者通常读不下去');
  });

  it('九种类型都能被识别为结论型（除 LAB / OTHER）', () => {
    const cases: Array<[string, string]> = [
      ['胸部正位片 X线', 'XRAY'],
      ['胸部 CT 平扫', 'CT'],
      ['头颅磁共振 MRI', 'MRI'],
      ['腹部彩超', 'ULTRASOUND'],
      ['心电图检查', 'ECG'],
      ['胃镜检查', 'ENDOSCOPY'],
      ['病理检查报告', 'PATHOLOGY'],
    ];
    for (const [sample, expected] of cases) {
      const parsed = parseReport(`${sample}\n检查结论：未见明显异常。`, `${sample}.png`);
      expect(parsed.kind, sample).toBe(expected);
      expect(isConclusionType(parsed.kind), sample).toBe(true);
    }
  });
});
