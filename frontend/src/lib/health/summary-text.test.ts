import { describe, expect, it, beforeEach } from 'vitest';
import { buildSummaryText, genderLabel, type SummaryInput } from './summary-text';
import { rememberHospitalCatalog, type PatientProfile } from '../api';
import type { MarkerTrend } from './markers';

/*
 * 院区展示名改为从后端目录动态获取之后，纯函数测试里没有加载目录，
 * hospitalName() 会退化成返回编码。这里显式注入一份最小的目录 ——
 * 测试不该依赖网络请求，但要知道「展示名从哪来」。
 */
beforeEach(() => {
  rememberHospitalCatalog([
    { code: 'MOCK-A', name: '演示市第一人民医院', departments: [] },
    { code: 'MOCK-B', name: '演示市中心医院', departments: [] },
    { code: 'Z2-JFL', name: '浙大二院（解放路院区）', departments: [] },
  ]);
});

const profile = (over: Partial<PatientProfile> = {}): PatientProfile => ({
  userId: 1,
  birthYear: 1965,
  age: 61,
  gender: 'MALE',
  allergies: ['青霉素'],
  chronics: ['高血压', '2型糖尿病'],
  medications: ['二甲双胍'],
  ...over,
});

const trend = (name: string, value: number, unit: string, level: 'normal' | 'high' | 'low'): MarkerTrend => ({
  name,
  unit,
  points: [{ date: '2026-11-10', value, level }],
  latest: value,
  delta: null,
  trendText: '',
});

const input = (over: Partial<SummaryInput> = {}): SummaryInput => ({
  profile: profile(),
  trends: [],
  records: [],
  medications: [],
  ...over,
});

describe('性别显示', () => {
  it('枚举转中文', () => {
    expect(genderLabel('MALE')).toBe('男');
    expect(genderLabel('FEMALE')).toBe('女');
  });

  it('已经是中文时原样返回', () => {
    expect(genderLabel('男')).toBe('男');
  });

  it('空值返回 null，不产出 "null" 字样', () => {
    expect(genderLabel(null)).toBeNull();
    expect(genderLabel(undefined)).toBeNull();
    expect(genderLabel('')).toBeNull();
  });

  it('未知值原样返回，不吞掉信息', () => {
    expect(genderLabel('UNKNOWN_X')).toBe('UNKNOWN_X');
  });
});

describe('摘要文本', () => {
  it('包含基本结构与过敏信息', () => {
    const t = buildSummaryText(input(), '2026-11-16');
    expect(t).toContain('【就诊摘要】');
    expect(t).toContain('61 岁 · 男');
    expect(t).toContain('过敏：青霉素');
    expect(t).toContain('慢病：高血压、2型糖尿病');
  });

  it('性别不会输出英文枚举', () => {
    const t = buildSummaryText(input(), '2026-11-16');
    expect(t).not.toContain('MALE');
    expect(t).toContain('男');
  });

  it('用药带剂量与频次', () => {
    const t = buildSummaryText(
      input({
        medications: [
          { name: '二甲双胍缓释片', dose: '0.5g', frequency: '每天 2 次', timing: '餐后' },
        ],
      }),
    );
    expect(t).toContain('二甲双胍缓释片 0.5g 每天 2 次 餐后');
  });

  it('只有药名时标「用法未记录」，不编造用法', () => {
    const t = buildSummaryText(
      input({ medications: [{ name: '氨氯地平片', dose: null, frequency: null, timing: null }] }),
    );
    expect(t).toContain('氨氯地平片（用法未记录）');
  });

  it('档案里有、病历里无用法记录的也列出', () => {
    const t = buildSummaryText(input({ profile: profile({ medications: ['阿司匹林肠溶片'] }) }));
    expect(t).toContain('阿司匹林肠溶片（用法未记录）');
  });

  it('指标带高低标注', () => {
    const t = buildSummaryText(
      input({
        trends: [
          trend('糖化血红蛋白', 7.8, '%', 'high'),
          trend('空腹血糖', 5.2, 'mmol/L', 'normal'),
        ],
      }),
    );
    expect(t).toContain('糖化血红蛋白 7.8 % 偏高（2026-11-10）');
    expect(t).toContain('空腹血糖 5.2 mmol/L（2026-11-10）');
    // 正常的指标不该被标「偏高」
    expect(t).not.toContain('空腹血糖 5.2 mmol/L 偏高');
  });

  it('就诊记录按时间倒序', () => {
    const t = buildSummaryText(
      input({
        records: [
          { visitDate: '2026-09-12', hospitalCode: 'MOCK-A', department: '内分泌科', diagnosisBrief: '早' },
          { visitDate: '2026-11-10', hospitalCode: 'MOCK-A', department: '内分泌科', diagnosisBrief: '晚' },
        ],
      }),
    );
    expect(t.indexOf('晚')).toBeLessThan(t.indexOf('早'));
  });

  it('院区显示中文名而非内部编码', () => {
    const t = buildSummaryText(
      input({
        records: [{ visitDate: '2026-11-10', hospitalCode: 'Z2-JFL', department: '内分泌科' }],
      }),
    );
    expect(t).toContain('浙大二院');
    expect(t).not.toContain('Z2-JFL');
  });

  it('末尾带来源与免责说明', () => {
    const t = buildSummaryText(
      input({
        records: [
          { visitDate: '2026-11-10', hospitalCode: 'MOCK-A' },
          { visitDate: '2026-10-20', hospitalCode: 'MOCK-B' },
        ],
      }),
    );
    expect(t).toContain('2 份病历');
    expect(t).toContain('覆盖 2 家医院');
    expect(t).toContain('仅供医生参考');
  });

  it('空数据也能生成，不崩', () => {
    const t = buildSummaryText(input({ profile: null }));
    expect(t).toContain('【就诊摘要】');
    expect(t).toContain('0 份病历');
    expect(t).not.toContain('undefined');
    expect(t).not.toContain('null');
  });

  it('不出现 undefined / null 字面量', () => {
    const t = buildSummaryText(
      input({
        records: [{ visitDate: '2026-11-10', hospitalCode: 'MOCK-A', department: null, diagnosisBrief: null }],
      }),
    );
    expect(t).not.toMatch(/undefined|null/);
  });
});
