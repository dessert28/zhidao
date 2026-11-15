import { describe, expect, it } from 'vitest';
import {
  dedupeByLatest,
  describeMedication,
  extractMedications,
  isInstructionComplete,
} from './medications';

describe('用药抽取', () => {
  it('中文写法：药名 + 剂量 + 频次 + 时机', () => {
    const [m] = extractMedications('二甲双胍缓释片 0.5g 每日2次 餐后', 'MOCK-A', '2026-09-12');
    expect(m!.name).toBe('二甲双胍缓释片');
    expect(m!.dose).toBe('0.5g');
    expect(m!.frequency).toBe('每天 2 次');
    expect(m!.timing).toBe('餐后');
  });

  it('医生速记写法：qd / bid / tid 翻成人话', () => {
    expect(extractMedications('氨氯地平片 5mg po qd')[0]!.frequency).toBe('每天 1 次');
    expect(extractMedications('二甲双胍片 0.5g bid')[0]!.frequency).toBe('每天 2 次');
    expect(extractMedications('阿莫西林胶囊 0.5g tid')[0]!.frequency).toBe('每天 3 次');
  });

  it('「每次一片」这种写法也能读', () => {
    const [m] = extractMedications('阿司匹林肠溶片 每日一次 每次一片');
    expect(m!.dose).toBe('1片');
    expect(m!.frequency).toBe('每天 1 次');
  });

  it('疗程能读出来', () => {
    expect(extractMedications('头孢克洛胶囊 0.25g tid 共7天')[0]!.duration).toBe('7天');
  });

  it('睡前/晨起等时机', () => {
    expect(extractMedications('辛伐他汀片 20mg 每晚1次 睡前')[0]!.timing).toBe('睡前');
  });

  it('一行多种药时按行拆分，不会张冠李戴', () => {
    /*
     * 这是最关键的一条：如果整段一起匹配，
     * 上一行的"每日2次"可能被算到下一行的药上。
     * 用药场景里这种错后果严重。
     */
    const list = extractMedications(
      '二甲双胍片 0.5g 每日2次\n氨氯地平片 5mg 每日1次',
    );
    expect(list).toHaveLength(2);
    const met = list.find((x) => x.name.includes('二甲双胍'))!;
    const aml = list.find((x) => x.name.includes('氨氯地平'))!;
    expect(met.frequency).toBe('每天 2 次');
    expect(aml.frequency).toBe('每天 1 次');
  });

  it('只写药名不写用法时，剂量与频次都是 null', () => {
    const [m] = extractMedications('建议服用二甲双胍片');
    expect(m!.dose).toBeNull();
    expect(m!.frequency).toBeNull();
  });

  it('抽不到药名返回空', () => {
    expect(extractMedications('建议低盐饮食，继续监测')).toEqual([]);
    expect(extractMedications('')).toEqual([]);
  });

  it('保留原始文本片段，供患者核对', () => {
    const [m] = extractMedications('二甲双胍缓释片 0.5g 每日2次');
    expect(m!.source).toContain('0.5g');
    expect(m!.visitDate).toBe('');
  });

  it('带上院区与日期，便于区分是哪次开的', () => {
    const [m] = extractMedications('二甲双胍片 0.5g bid', 'Z2-JFL', '2026-10-20');
    expect(m!.hospitalCode).toBe('Z2-JFL');
    expect(m!.visitDate).toBe('2026-10-20');
  });
});

describe('展示', () => {
  it('完整信息拼成一句', () => {
    const [m] = extractMedications('二甲双胍缓释片 0.5g 每日2次 餐后');
    expect(describeMedication(m!)).toBe('0.5g · 每天 2 次 · 餐后');
  });

  it('缺用法时明确说"病历未记录"，而不是省略', () => {
    const [m] = extractMedications('建议服用二甲双胍片');
    const text = describeMedication(m!);
    expect(text).toContain('没有记录');
    expect(text).toContain('药师');
  });

  it('isInstructionComplete 能区分有没有用法', () => {
    const withFreq = extractMedications('二甲双胍片 0.5g bid')[0]!;
    const nameOnly = extractMedications('二甲双胍片')[0]!;
    expect(isInstructionComplete(withFreq)).toBe(true);
    expect(isInstructionComplete(nameOnly)).toBe(false);
  });
});

describe('去重', () => {
  it('同名药保留最近一次就诊的记录', () => {
    const list = extractMedications(
      '二甲双胍片 0.5g 每日2次\n二甲双胍片 0.5g 每日3次',
      'MOCK-A',
      '2026-09-12',
    );
    const list2 = extractMedications('二甲双胍片 0.85g 每日2次', 'MOCK-B', '2026-10-20');
    const merged = dedupeByLatest([...list, ...list2]);
    const met = merged.find((x) => x.name === '二甲双胍片')!;
    expect(met.visitDate).toBe('2026-10-20');
    expect(met.dose).toBe('0.85g');
  });

  it('不同药名都保留', () => {
    const list = [
      ...extractMedications('二甲双胍片 0.5g bid', 'A', '2026-09-01'),
      ...extractMedications('氨氯地平片 5mg qd', 'A', '2026-09-01'),
    ];
    expect(dedupeByLatest(list)).toHaveLength(2);
  });
});

describe('安全边界', () => {
  it('不因为只有药名就编造用法', () => {
    /*
     * 这是本模块最重要的性质：宁可不给，也不能猜。
     * 建立"药名 → 常用用法"的词典会把"整理"变成"开药"。
     */
    const [m] = extractMedications('二甲双胍片');
    expect(m!.dose).toBeNull();
    expect(m!.frequency).toBeNull();
    expect(describeMedication(m!)).toContain('咨询药师');
  });
});
