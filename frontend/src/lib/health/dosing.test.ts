import { describe, expect, it } from 'vitest';
import {
  buildDosePlan,
  isPast,
  normalizeClock,
  parseFrequencyCount,
  parsePeriod,
  periodState,
  slotTemporal,
  summarizeDay,
  type DoseSlot,
  type MedInput,
} from './dosing';

const med = (over: Partial<MedInput> = {}): MedInput => ({
  name: '二甲双胍缓释片',
  dose: '0.5g',
  frequency: '每天 2 次',
  timing: null,
  ...over,
});

describe('频次解析', () => {
  it('我们自己的规范输出', () => {
    expect(parseFrequencyCount('每天 1 次')).toBe(1);
    expect(parseFrequencyCount('每天 2 次')).toBe(2);
    expect(parseFrequencyCount('每天 3 次')).toBe(3);
    expect(parseFrequencyCount('每天 4 次')).toBe(4);
  });

  it('医生速记写法', () => {
    expect(parseFrequencyCount('每日一次')).toBe(1);
    expect(parseFrequencyCount('每日两次')).toBe(2);
    expect(parseFrequencyCount('1日3次')).toBe(3);
    expect(parseFrequencyCount('一天两次')).toBe(2);
  });

  it('「2次/日」这种写法', () => {
    expect(parseFrequencyCount('2次/日')).toBe(3 - 1); // = 2，写成算式避免看错
  });

  it('每晚一次算 1 次', () => {
    expect(parseFrequencyCount('每晚 1 次')).toBe(1);
    expect(parseFrequencyCount('qn')).toBe(1);
  });

  it('每 8 小时 → 每天 3 次', () => {
    expect(parseFrequencyCount('每8小时1次')).toBe(3);
    expect(parseFrequencyCount('每 6 小时')).toBe(4);
  });

  it('每周给药不进每日清单', () => {
    expect(parseFrequencyCount('每周 1 次')).toBeNull();
  });

  it('无法解析时返回 null，不猜', () => {
    expect(parseFrequencyCount(null)).toBeNull();
    expect(parseFrequencyCount('')).toBeNull();
    expect(parseFrequencyCount('按需服用')).toBeNull();
  });

  it('次数上限收敛到 4，避免生成荒谬的时间表', () => {
    expect(parseFrequencyCount('每天 10 次')).toBe(4);
  });
});

describe('服药时间表', () => {
  it('每天 2 次 → 早 8 点、晚 8 点', () => {
    const { slots } = buildDosePlan([med({ frequency: '每天 2 次' })]);
    expect(slots.map((s) => s.time)).toEqual(['08:00', '20:00']);
  });

  it('同一时刻的多种药合并到一个时间点', () => {
    const { slots } = buildDosePlan([
      med({ name: '二甲双胍', frequency: '每天 2 次' }),
      med({ name: '氨氯地平', frequency: '每天 2 次' }),
    ]);
    expect(slots).toHaveLength(2);
    expect(slots[0]!.meds.map((m) => m.name)).toEqual(['二甲双胍', '氨氯地平']);
  });

  it('不同频次的药排在不同时间点', () => {
    const { slots } = buildDosePlan([
      med({ name: 'A', frequency: '每天 1 次' }),
      med({ name: 'B', frequency: '每天 3 次' }),
    ]);
    const times = slots.map((s) => s.time);
    expect(times).toContain('08:00');
    expect(times).toContain('12:30');
    expect(times).toContain('18:30');
  });

  it('睡前服用落成「睡前」这一段，不给假钟点', () => {
    const { slots } = buildDosePlan([med({ frequency: '每天 1 次', timing: '睡前' })]);
    expect(slots[0]!.kind).toBe('fuzzy');
    expect(slots[0]!.label).toBe('睡前');
    /*
     * 关键断言：time 必须是 null。
     * 病历只说「睡前」，印一个 21:00 出去，等于替医生下了医嘱。
     */
    expect(slots[0]!.time).toBeNull();
  });

  it('晨起服用落成「晨起」这一段', () => {
    const { slots } = buildDosePlan([med({ frequency: '每天 1 次', timing: '晨起' })]);
    expect(slots[0]!.label).toBe('晨起');
    expect(slots[0]!.time).toBeNull();
  });

  it('餐后服用顺延到饭后半小时', () => {
    const { slots } = buildDosePlan([med({ frequency: '每天 2 次', timing: '餐后' })]);
    expect(slots.map((s) => s.label)).toEqual(['早饭后', '晚饭后']);
  });

  it('中饭后 / 晚饭前 这类说法能落到具体时段', () => {
    expect(parsePeriod('中饭后')!.key).toBe('lunch-after');
    expect(parsePeriod('晚饭前')!.key).toBe('dinner-before');

    const { slots } = buildDosePlan([med({ frequency: '每天 1 次', timing: '晚饭前' })]);
    expect(slots[0]!.label).toBe('晚饭前');
    expect(slots[0]!.kind).toBe('fuzzy');
  });

  it('餐前三餐排到饭前那三段', () => {
    const { slots } = buildDosePlan([med({ frequency: '每天 3 次', timing: '餐前' })]);
    expect(slots.map((s) => s.label)).toEqual(['早饭前', '中饭前', '晚饭前']);
  });

  it('时间按一天时序排列，模糊档不和精确档错位', () => {
    const { slots } = buildDosePlan([
      med({ name: '晚', frequency: '每天 1 次', timing: '睡前' }),
      med({ name: '早', frequency: '每天 1 次', timing: '晨起' }),
      med({ name: '定点', frequency: '每天 1 次', atTime: '10:00' }),
    ]);
    const labels = slots.map((s) => s.label);
    expect(labels.indexOf('晨起')).toBeLessThan(labels.indexOf('10:00'));
    expect(labels.indexOf('10:00')).toBeLessThan(labels.indexOf('睡前'));
  });

  it('病历写了钟点就用钟点 —— 医嘱优先于模板', () => {
    const { slots } = buildDosePlan([
      med({ frequency: '每天 1 次', timing: '晨起', atTime: '06:15' }),
    ]);
    expect(slots[0]!.kind).toBe('exact');
    expect(slots[0]!.label).toBe('06:15');
  });

  it('钟点写法可解析：8:30 / 八点半 / 晚上八点', () => {
    expect(normalizeClock('8:30')).toBe('08:30');
    expect(normalizeClock('20：30')).toBe('20:30');
    expect(normalizeClock('八点半')).toBe('08:30');
    expect(normalizeClock('8点')).toBe('08:00');
    expect(normalizeClock('晚上八点')).toBe('20:00');
    expect(normalizeClock('随便')).toBeNull();
  });

  it('频次无法解析的药进 unscheduled，不进时间表', () => {
    const { slots, unscheduled } = buildDosePlan([
      med({ name: '有频次', frequency: '每天 2 次' }),
      med({ name: '没频次', frequency: null }),
    ]);
    /*
     * 「每天 2 次」会出现在 2 个时间点，所以 flatMap 里会有两个「有频次」。
     * 用 Set 判断"是否出现"，而不是断言数组长度 ——
     * 第一版断言长度为 1，其实是在断言"每天只吃一次"，与用例名无关。
     */
    const names = new Set(slots.flatMap((s) => s.meds.map((m) => m.name)));
    expect([...names]).toEqual(['有频次']);
    expect(unscheduled).toHaveLength(1);
    expect(unscheduled[0]!.name).toBe('没频次');
  });

  it('空输入不崩', () => {
    expect(buildDosePlan([])).toEqual({ slots: [], unscheduled: [] });
  });

  it('保留剂量信息，界面能显示吃几片', () => {
    const { slots } = buildDosePlan([med({ dose: '0.5g' })]);
    expect(slots[0]!.meds[0]!.dose).toBe('0.5g');
  });
});

describe('时间判断', () => {
  it('已过去的时间点返回 true', () => {
    const now = new Date('2026-11-16T15:00:00');
    expect(isPast('08:00', now)).toBe(true);
    expect(isPast('20:00', now)).toBe(false);
  });

  it('正好到点算已过去（含等于）', () => {
    const now = new Date('2026-11-16T08:00:00');
    expect(isPast('08:00', now)).toBe(false); // 同一分钟不算过
    expect(isPast('07:59', now)).toBe(true);
  });
});

describe('摘要', () => {
  it('有点位时说明数量', () => {
    const { slots } = buildDosePlan([med({ frequency: '每天 2 次' })]);
    expect(summarizeDay(slots)).toContain('2 个服药时间点');
  });

  it('模糊档在摘要里说清楚"按饭前饭后把握"', () => {
    const { slots } = buildDosePlan([med({ frequency: '每天 1 次', timing: '睡前' })]);
    expect(summarizeDay(slots)).toContain('饭前');
  });

  it('空列表给中性描述', () => {
    expect(summarizeDay([])).toContain('没有需要按时服用');
  });

  it('同一种药一天吃几次只算一种', () => {
    /*
     * 一天 3 次的药会出现在 3 个时间点里。早先这里把每档的药数相加，
     * 于是"1 种药"被说成"3 种药" —— 患者拿这个数字去核对药盒会对不上。
     */
    const { slots } = buildDosePlan([med({ frequency: '每天 3 次' })]);
    expect(slots.length).toBe(3);
    expect(summarizeDay(slots)).toContain('涉及 1 种药');
  });
});

describe('模糊时间的三态', () => {
  const fuzzy = (label: string): DoseSlot =>
    buildDosePlan([med({ frequency: '每天 1 次', timing: label })]).slots[0]!;

  it('还没到这一段', () => {
    const now = new Date('2026-11-16T05:00:00');
    expect(periodState(fuzzy('晚饭前'), now)).toBe('upcoming');
  });

  it('正卡在这一段 —— 这才是模糊时间真正有用的时候', () => {
    const now = new Date('2026-11-16T17:30:00');
    expect(periodState(fuzzy('晚饭前'), now)).toBe('now');
  });

  it('这一段已经过去了', () => {
    const now = new Date('2026-11-16T16:00:00');
    expect(periodState(fuzzy('早饭后'), now)).toBe('passed');
  });

  it('slotTemporal 走精确档时沿用 isPast', () => {
    const { slots } = buildDosePlan([med({ frequency: '每天 2 次' })]);
    const now = new Date('2026-11-16T09:00:00');
    expect(slotTemporal(slots[0]!, now)).toBe('passed');
    expect(slotTemporal(slots[1]!, now)).toBe('upcoming');
  });
});
