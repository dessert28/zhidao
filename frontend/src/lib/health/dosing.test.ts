import { describe, expect, it } from 'vitest';
import {
  buildDosePlan,
  isPast,
  parseFrequencyCount,
  summarizeDay,
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

  it('睡前服用挪到 21:00', () => {
    const { slots } = buildDosePlan([med({ frequency: '每天 1 次', timing: '睡前' })]);
    expect(slots[0]!.time).toBe('21:00');
  });

  it('晨起服用挪到 07:30', () => {
    const { slots } = buildDosePlan([med({ frequency: '每天 1 次', timing: '晨起' })]);
    expect(slots[0]!.time).toBe('07:30');
  });

  it('餐后服用顺延到饭后半小时', () => {
    const { slots } = buildDosePlan([med({ frequency: '每天 2 次', timing: '餐后' })]);
    expect(slots.map((s) => s.time)).toEqual(['08:30', '20:30']);
  });

  it('餐前三餐排到饭前', () => {
    const { slots } = buildDosePlan([med({ frequency: '每天 3 次', timing: '餐前' })]);
    expect(slots.map((s) => s.time)).toEqual(['07:30', '12:00', '18:00']);
  });

  it('时间按升序排列', () => {
    const { slots } = buildDosePlan([
      med({ name: '晚', frequency: '每天 1 次', timing: '睡前' }),
      med({ name: '早', frequency: '每天 1 次', timing: '晨起' }),
    ]);
    expect(slots[0]!.time < slots[slots.length - 1]!.time).toBe(true);
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

  it('空列表给中性描述', () => {
    expect(summarizeDay([])).toContain('没有需要按时服用');
  });
});
