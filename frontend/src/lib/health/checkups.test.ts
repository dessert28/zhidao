import { describe, expect, it } from 'vitest';
import {
  CHECKUP_RULES,
  buildCheckupSuggestions,
  monthsBetween,
  summarizeCheckups,
} from './checkups';
import type { MedicalRecord } from '../api';

const rec = (id: number, date: string, text: string, dept = '内分泌科'): MedicalRecord => ({
  id,
  hospitalCode: 'MOCK-A',
  visitDate: date,
  department: dept,
  diagnosisBrief: '',
  ocrText: text,
  fileName: null,
  source: 'UPLOAD',
});

describe('月份差', () => {
  it('跨年也算对', () => {
    expect(monthsBetween('2025-11-01', '2026-11-01')).toBe(12);
  });
  it('不足一个月算 0', () => {
    expect(monthsBetween('2026-11-01', '2026-11-20')).toBe(0);
  });
});

describe('定期检查建议', () => {
  it('糖尿病患者应得到眼底、尿微量白蛋白、糖化、足部四项', () => {
    const out = buildCheckupSuggestions(['2型糖尿病'], [rec(1, '2026-01-01', '血糖偏高')]);
    const names = out.map((x) => x.name);
    expect(names).toContain('眼底检查');
    expect(names).toContain('尿微量白蛋白 / 肾功能');
    expect(names).toContain('糖化血红蛋白');
    expect(names).toContain('足部检查');
  });

  it('没有慢病时不产生任何建议', () => {
    expect(buildCheckupSuggestions([], [])).toEqual([]);
  });

  it('病历里查不到记录 → UNKNOWN，不催', () => {
    const out = buildCheckupSuggestions(['高血压'], []);
    const ecg = out.find((x) => x.name === '心电图')!;
    expect(ecg.status).toBe('UNKNOWN');
    expect(ecg.lastDone).toBeNull();
  });

  it('查过且超期 → DUE', () => {
    const out = buildCheckupSuggestions(
      ['2型糖尿病'],
      [rec(1, '2024-01-01', '眼底检查未见异常')],
      '2026-11-15',
    );
    const eye = out.find((x) => x.name === '眼底检查')!;
    expect(eye.status).toBe('DUE');
    expect(eye.lastDone).toBe('2024-01-01');
    expect(eye.monthsSince).toBeGreaterThan(12);
  });

  it('查过但还在有效期内 → NOT_YET', () => {
    const out = buildCheckupSuggestions(
      ['2型糖尿病'],
      [rec(1, '2026-06-01', '眼底检查')],
      '2026-11-15',
    );
    const eye = out.find((x) => x.name === '眼底检查')!;
    expect(eye.status).toBe('NOT_YET');
  });

  it('多次记录取最近一次', () => {
    const out = buildCheckupSuggestions(
      ['2型糖尿病'],
      [rec(1, '2024-01-01', '眼底检查'), rec(2, '2026-09-01', '眼底检查')],
      '2026-11-15',
    );
    const eye = out.find((x) => x.name === '眼底检查')!;
    expect(eye.lastDone).toBe('2026-09-01');
    expect(eye.status).toBe('NOT_YET');
  });

  it('排序：DUE 在前，UNKNOWN 其次，NOT_YET 最后', () => {
    const out = buildCheckupSuggestions(
      ['2型糖尿病'],
      [rec(1, '2024-01-01', '眼底检查')],
      '2026-11-15',
    );
    const firstStatus = out[0]!.status;
    expect(firstStatus).toBe('DUE');
    // 末尾不应出现 DUE
    expect(out[out.length - 1]!.status).not.toBe('DUE');
  });

  it('每条都带依据来源', () => {
    const out = buildCheckupSuggestions(['2型糖尿病'], []);
    for (const s of out) {
      expect(s.basis.length, `${s.name} 缺依据`).toBeGreaterThan(5);
      expect(s.reason.length, `${s.name} 缺理由`).toBeGreaterThan(10);
      expect(s.where.length, `${s.name} 缺去哪做`).toBeGreaterThan(2);
    }
  });

  it('同一病种的不同写法不会产生重复建议', () => {
    const out = buildCheckupSuggestions(['糖尿病', '2型糖尿病'], []);
    const eyeCount = out.filter((x) => x.name === '眼底检查').length;
    expect(eyeCount).toBe(1);
  });
});

describe('摘要', () => {
  it('有到期项时点名', () => {
    const out = buildCheckupSuggestions(
      ['2型糖尿病'],
      [rec(1, '2024-01-01', '眼底检查')],
      '2026-11-15',
    );
    expect(summarizeCheckups(out)).toContain('该做了');
  });

  it('全部未知时说明不掌握记录', () => {
    const out = buildCheckupSuggestions(['高血压'], []);
    expect(summarizeCheckups(out)).toContain('不掌握记录');
  });

  it('空列表给中性描述', () => {
    expect(summarizeCheckups([])).toContain('有效期内');
  });
});

describe('规则表质量', () => {
  it('每条规则都有依据与理由', () => {
    for (const r of CHECKUP_RULES) {
      expect(r.basis, r.name).toBeTruthy();
      expect(r.reason.length, r.name).toBeGreaterThan(10);
      expect(r.intervalMonths, r.name).toBeGreaterThan(0);
      expect(r.detectPatterns.length, r.name).toBeGreaterThan(0);
    }
  });

  it('理由里不出现诊断口吻', () => {
    const forbidden = /你(这)?(是|得了|患了|确诊)/;
    for (const r of CHECKUP_RULES) {
      expect(forbidden.test(r.reason), r.name).toBe(false);
    }
  });
});
