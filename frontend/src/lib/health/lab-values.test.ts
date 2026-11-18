/* ------------------------------------------------------------------
 * 化验单数值解析 —— 盯的是「一项不落地读出来，且只比区间不下判断」
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { judgeResult, parseBounds, parseLabValues, summarizeLabValues } from './lab-values';

/** OCR 入库时的标准格式（见 server/ocr/recognize.ts 的 buildOcrText） */
const OCR_TEXT = [
  '检查名称：血常规',
  '姓名：张三  性别：男  科室：心血管内科',
  '白细胞计数 6.2 10^9/L（参考范围 3.5-9.5）',
  '中性粒细胞比率 62 %（参考范围 40-75）',
  '淋巴细胞比率 28 %（参考范围 20-50）',
  '血红蛋白 128 g/L（参考范围 130-175）',
  '红细胞压积 42.5 %（参考范围 40-50）',
  '平均红细胞体积 88.4 fL（参考范围 82-100）',
  '报告日期 2026-11-18',
  '检验者：李医生',
].join('\n');

describe('parseLabValues', () => {
  it('读出标准 OCR 文本里的每一行数值', () => {
    const rows = parseLabValues(OCR_TEXT);
    expect(rows.map((r) => r.name)).toEqual([
      '白细胞计数',
      '中性粒细胞比率',
      '淋巴细胞比率',
      '血红蛋白',
      '红细胞压积',
      '平均红细胞体积',
    ]);
    const hgb = rows.find((r) => r.name === '血红蛋白')!;
    expect(hgb.result).toBe('128');
    expect(hgb.unit).toBe('g/L');
    expect(hgb.refText).toBe('130-175');
    expect(hgb.flag).toBe('low');
  });

  it('没有「参考范围」标签时，靠位置认出区间', () => {
    const rows = parseLabValues('血红蛋白 128 g/L 130-175');
    expect(rows[0]!.refText).toBe('130-175');
    expect(rows[0]!.flag).toBe('low');
  });

  it('箭头优先于数值比较', () => {
    const rows = parseLabValues('白细胞计数 9.0 10^9/L ↑（参考范围 3.5-9.5）');
    expect(rows[0]!.flag).toBe('high');
  });

  it('数值与单位粘在一起也能拆开', () => {
    const rows = parseLabValues('血红蛋白 128g/L（参考范围 130-175）');
    expect(rows[0]!.result).toBe('128');
    expect(rows[0]!.unit).toBe('g/L');
  });

  it('定性结果（阴性）也能读，但不判断高低', () => {
    const rows = parseLabValues('尿蛋白 阴性 参考范围 阴性');
    expect(rows[0]!.result).toBe('阴性');
    expect(rows[0]!.unit).toBeNull();
    expect(rows[0]!.flag).toBe('unknown');
  });

  it('页眉、标本信息、医师签名不当成指标', () => {
    const names = parseLabValues(OCR_TEXT).map((r) => r.name);
    expect(names).not.toContain('姓名');
    expect(names).not.toContain('报告日期');
    expect(names).not.toContain('检验者');
  });

  it('同一项目名只保留第一条', () => {
    const rows = parseLabValues('血红蛋白 128 g/L 130-175\n血红蛋白 128 g/L 130-175');
    expect(rows).toHaveLength(1);
  });

  it('用药清单不会被当成化验结果', () => {
    const rows = parseLabValues(
      ['阿司匹林肠溶片 100 mg', '二甲双胍缓释片 0.5 g', '用法：每日一次，每次一片'].join('\n'),
    );
    expect(rows).toEqual([]);
  });

  it('名字里带数字的连写行不猜', () => {
    // 门诊记录的写法，不是化验单的写法；猜下去会读出一条不存在的结果
    expect(parseLabValues('血压152/94mmHg，空腹血糖 7.6 mmol/L（参考范围 3.9-6.1）')).toEqual([]);
  });

  it('读不出数值时返回空数组，而不是编一条出来', () => {
    expect(parseLabValues('检查所见：双肺纹理清晰。检查结论：未见明显异常。')).toEqual([]);
    expect(parseLabValues('')).toEqual([]);
  });

  it('汇总里分别统计高于与低于的条数', () => {
    const s = summarizeLabValues(parseLabValues(OCR_TEXT));
    expect(s.rows).toHaveLength(6);
    expect(s.low).toBe(1);
    expect(s.high).toBe(0);
  });
});

describe('parseBounds', () => {
  it('区间、单边上下限', () => {
    expect(parseBounds('3.5-9.5')).toEqual({ low: 3.5, high: 9.5 });
    expect(parseBounds('<5.2')).toEqual({ low: null, high: 5.2 });
    expect(parseBounds('≥60')).toEqual({ low: 60, high: null });
  });

  it('单独一个数字不猜是上限还是下限', () => {
    expect(parseBounds('5')).toBeNull();
    expect(parseBounds('阴性')).toBeNull();
  });
});

describe('judgeResult', () => {
  it('只比区间，不解释', () => {
    expect(judgeResult('6.2', 3.5, 9.5)).toBe('normal');
    expect(judgeResult('12.4', 3.5, 9.5)).toBe('high');
    expect(judgeResult('2.1', 3.5, 9.5)).toBe('low');
  });

  it('没有参考范围就是 unknown', () => {
    expect(judgeResult('6.2', null, null)).toBe('unknown');
  });
});
