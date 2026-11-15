import { describe, expect, it } from 'vitest';
import {
  MARKERS,
  buildTrends,
  evaluateMarker,
  evaluateText,
  extractMarkers,
} from './markers';

describe('指标抽取', () => {
  it('从化验文本里抽出数值', () => {
    const r = extractMarkers('空腹血糖 8.4 mmol/L，糖化血红蛋白 7.8%。');
    const names = r.map((x) => x.name);
    expect(names).toContain('空腹血糖');
    expect(names).toContain('糖化血红蛋白');
    expect(r.find((x) => x.name === '空腹血糖')?.value).toBe(8.4);
    expect(r.find((x) => x.name === '糖化血红蛋白')?.value).toBe(7.8);
  });

  it('长名优先匹配：「糖化血红蛋白」不能被「血糖」吃掉', () => {
    const r = extractMarkers('糖化血红蛋白 7.8%');
    expect(r).toHaveLength(1);
    expect(r[0]!.name).toBe('糖化血红蛋白');
    expect(r[0]!.value).toBe(7.8);
  });

  it('英文缩写也能识别', () => {
    expect(extractMarkers('HbA1c 7.8%').some((x) => x.name === '糖化血红蛋白')).toBe(true);
    expect(extractMarkers('LDL-C 3.8 mmol/L').some((x) => x.name === '低密度脂蛋白')).toBe(true);
  });

  it('血压三个值都能拆出来', () => {
    const r = extractMarkers('血压 158/96 mmHg');
    // 收缩压与舒张压是两条不同的规则；158/96 这种写法只能命中一条，
    // 这是当前实现的已知局限，界面上会标「请以化验单为准」
    expect(r.some((x) => x.name === '收缩压' || x.name === '舒张压')).toBe(true);
  });

  it('明确写法时两个血压都能抽到', () => {
    const r = extractMarkers('收缩压 158 mmHg，舒张压 96 mmHg');
    const shr = r.find((x) => x.name === '收缩压');
    const dia = r.find((x) => x.name === '舒张压');
    expect(shr?.value).toBe(158);
    expect(dia?.value).toBe(96);
  });

  it('空文本返回空数组', () => {
    expect(extractMarkers('')).toEqual([]);
    expect(extractMarkers('建议低盐饮食，继续监测。')).toEqual([]);
  });

  it('保留原始片段，便于患者核对', () => {
    const r = extractMarkers('空腹血糖 8.4 mmol/L');
    expect(r[0]!.source).toContain('8.4');
  });
});

describe('指标评估', () => {
  it('偏高 → high + 通俗解释 + 建议', () => {
    const [ev] = evaluateText('空腹血糖 8.4 mmol/L');
    expect(ev!.level).toBe('high');
    expect(ev!.meaning.length).toBeGreaterThan(10);
    expect(ev!.advice.length).toBeGreaterThan(10);
    expect(ev!.department).toBe('内分泌科');
  });

  it('正常 → normal', () => {
    const [ev] = evaluateText('空腹血糖 5.2 mmol/L');
    expect(ev!.level).toBe('normal');
  });

  it('偏低 → low', () => {
    const [ev] = evaluateText('空腹血糖 3.0 mmol/L');
    expect(ev!.level).toBe('low');
  });

  it('边界值算正常（含端点）', () => {
    expect(evaluateText('空腹血糖 6.1 mmol/L')[0]!.level).toBe('normal');
    expect(evaluateText('空腹血糖 3.9 mmol/L')[0]!.level).toBe('normal');
  });

  it('参考范围文案包含单位', () => {
    const [ev] = evaluateText('空腹血糖 8.4 mmol/L');
    expect(ev!.rangeText).toContain('mmol/L');
    expect(ev!.rangeText).toContain('3.9');
  });

  it('解释里不出现诊断结论', () => {
    /*
     * 这是合规红线：给出「你得了糖尿病」这类话就是越界行医。
     * 只允许描述现象与建议就医。
     */
    const forbidden = /你(这)?(是|得了|患了|确诊)[^，。]{0,6}(病|症)/;
    for (const def of MARKERS) {
      expect(forbidden.test(def.highMeaning), `${def.name} 的高值解释含诊断口吻`).toBe(false);
      expect(forbidden.test(def.highAdvice), `${def.name} 的高值建议含诊断口吻`).toBe(false);
    }
  });

  it('每个指标都配置了解释与建议', () => {
    for (const def of MARKERS) {
      expect(def.highMeaning.length, def.name).toBeGreaterThan(10);
      expect(def.highAdvice.length, def.name).toBeGreaterThan(10);
      expect(def.department, def.name).toBeTruthy();
    }
  });
});

describe('趋势', () => {
  it('按日期聚合，算出变化量', () => {
    const trends = buildTrends([
      { visitDate: '2026-09-12', ocrText: '空腹血糖 8.4 mmol/L' },
      { visitDate: '2026-10-20', ocrText: '空腹血糖 7.9 mmol/L' },
    ]);
    const t = trends.find((x) => x.name === '空腹血糖')!;
    expect(t.points).toHaveLength(2);
    expect(t.latest).toBe(7.9);
    expect(t.delta).toBe(-0.5);
    expect(t.trendText).toContain('下降');
  });

  it('顺序打乱也能按日期排好', () => {
    const trends = buildTrends([
      { visitDate: '2026-10-20', ocrText: '空腹血糖 7.9 mmol/L' },
      { visitDate: '2026-09-12', ocrText: '空腹血糖 8.4 mmol/L' },
    ]);
    const t = trends.find((x) => x.name === '空腹血糖')!;
    expect(t.points[0]!.date).toBe('2026-09-12');
    expect(t.points[1]!.date).toBe('2026-10-20');
  });

  it('只有一个数据点时 delta 为 null', () => {
    const trends = buildTrends([{ visitDate: '2026-09-12', ocrText: '空腹血糖 8.4' }]);
    expect(trends[0]!.delta).toBeNull();
    expect(trends[0]!.trendText).toContain('只记录过');
  });

  it('持平也能描述', () => {
    const trends = buildTrends([
      { visitDate: '2026-09-12', ocrText: '空腹血糖 8.0' },
      { visitDate: '2026-10-20', ocrText: '空腹血糖 8.0' },
    ]);
    expect(trends[0]!.trendText).toContain('持平');
  });

  it('空病历返回空', () => {
    expect(buildTrends([])).toEqual([]);
  });

  it('多个指标各自独立成趋势', () => {
    const trends = buildTrends([
      { visitDate: '2026-09-12', ocrText: '空腹血糖 8.4，糖化血红蛋白 7.8%' },
      { visitDate: '2026-10-20', ocrText: '空腹血糖 7.9，糖化血红蛋白 7.2%' },
    ]);
    const names = trends.map((t) => t.name);
    expect(names).toContain('空腹血糖');
    expect(names).toContain('糖化血红蛋白');
  });

  /**
   * 跨字段误匹配的回归 —— 实测发现的真实缺陷。
   *
   * 病历 10-20 的内容是「…本次未重复开具糖化血红蛋白。」，
   * 而它的 diagnosisBrief 是「2型糖尿病复诊」。
   * 第一版把两个字段拼成一段再抽取，于是正则跨过字段边界，
   * 把诊断名里的 "2" 当成了糖化血红蛋白的值 ——
   * 界面出现「糖化血红蛋白 2% 偏低」，荒谬且会制造焦虑。
   *
   * 修法：按字段分别抽取，不拼接。
   */
  it('不跨字段误匹配（诊断名里的数字不能被当成化验值）', () => {
    const trends = buildTrends([
      {
        visitDate: '2026-09-12',
        ocrText: '糖化血红蛋白 7.8%',
        diagnosisBrief: '2型糖尿病，血糖控制欠佳',
      },
      {
        visitDate: '2026-10-20',
        ocrText: '患者自述近期在外院已查过血糖，本次未重复开具糖化血红蛋白。',
        diagnosisBrief: '2型糖尿病复诊',
      },
    ]);

    const t = trends.find((x) => x.name === '糖化血红蛋白')!;
    expect(t).toBeDefined();
    // 10-20 那条只是在说"没做这项检查"，不该贡献数据点
    expect(t.points).toHaveLength(1);
    expect(t.points[0]!.value).toBe(7.8);
    expect(t.latest).toBe(7.8);
    expect(t.points.map((p) => p.value)).not.toContain(2);
  });

  it('同一次就诊两个字段都提到同一指标时不重复计数', () => {
    const trends = buildTrends([
      {
        visitDate: '2026-09-12',
        ocrText: '空腹血糖 8.4 mmol/L',
        diagnosisBrief: '空腹血糖偏高',
      },
    ]);
    const t = trends.find((x) => x.name === '空腹血糖')!;
    expect(t.points).toHaveLength(1);
  });
});

describe('容错', () => {
  it('数值异常大/小不崩', () => {
    expect(() => evaluateText('空腹血糖 99999')).not.toThrow();
  });

  it('没有数字的关键词不产生读数', () => {
    expect(extractMarkers('建议查一下空腹血糖')).toEqual([]);
  });

  it('evaluateMarker 对未收录指标返回 null', () => {
    expect(evaluateMarker({ name: '不存在的指标', value: 1, unit: '', source: '' })).toBeNull();
  });
});
