/* ------------------------------------------------------------------
 * 检查顺序规划的测试
 *
 * 顺序排错的表现不是"报错"，而是**患者白跑一趟**（先吃了东西才去抽血、
 * 或者拍完片回来抽血窗口已经关了）。所以这里重点测四件事：
 *   1. 空腹抽血确实排第一
 *   2. 需要预约的影像排在常规项目之前
 *   3. 空腹未知的项目必须标 needsConfirmation，且不往前挤
 *   4. 同档内保持检查单原顺序（患者的单子和界面对得上）
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { planExamSequence } from './sequence';
import type { ParsedExam } from './order-parse';

/** 造一个检查项目，只写测试关心的字段 */
function exam(
  name: string,
  placeType: ParsedExam['placeType'],
  fasting: boolean | null,
): ParsedExam {
  return { name, placeType, fasting, evidence: name };
}

/** 取顺序后的项目名，便于断言 */
function names(exams: ParsedExam[]): string[] {
  return planExamSequence(exams).map((s) => s.exam.name);
}

describe('planExamSequence：档位', () => {
  it('需要空腹的抽血排在最前 —— 患者还空着肚子，先抽完才能吃', () => {
    const out = names([
      exam('胸部 CT', 'EXAM', false),
      exam('腹部彩超', 'EXAM', false),
      exam('空腹血糖', 'LAB', true),
    ]);
    expect(out[0]).toBe('空腹血糖');
  });

  it('需要预约的影像次之，排在普通项目之前', () => {
    const out = names([
      exam('血常规', 'LAB', false),
      exam('腹部彩超', 'EXAM', false),
      exam('胸部 CT 平扫', 'EXAM', false),
    ]);
    // CT 要先排号，普通抽血和彩超顺路做
    expect(out[0]).toBe('胸部 CT 平扫');
  });

  it('需要空腹但不属于抽血的项目，也排在常规项目之前', () => {
    const out = names([
      exam('心电图', 'EXAM', false),
      exam('腹部彩超', 'EXAM', true),
    ]);
    // 腹部彩超的空腹窗口和抽血是同一段，不能等到患者吃完再做
    expect(out[0]).toBe('腹部彩超');
  });

  it('MRI / 胃镜这类同样算需要预约的影像', () => {
    const out = names([
      exam('血常规', 'LAB', false),
      exam('头颅 MRI', 'EXAM', false),
      exam('胃镜', 'EXAM', false),
    ]);
    expect(out.slice(0, 2).sort()).toEqual(['头颅 MRI', '胃镜'].sort());
  });
});

describe('planExamSequence：空腹未知', () => {
  it('fasting === null 标记 needsConfirmation，并提示问分诊台', () => {
    const steps = planExamSequence([exam('血常规', 'LAB', null)]);
    expect(steps[0]?.needsConfirmation).toBe(true);
    expect(steps[0]?.reason).toContain('分诊台');
  });

  it('已知空腹状态的项目不需要确认', () => {
    const steps = planExamSequence([exam('血常规', 'LAB', false), exam('空腹血糖', 'LAB', true)]);
    expect(steps.every((s) => !s.needsConfirmation)).toBe(true);
  });

  it('空腹未知的常规项目排在已知项目之后', () => {
    /*
     * 不知道要不要空腹 → 既不能当"不用空腹"直接排前面让患者先吃，
     * 也不能当空腹项目插队。放最后，让患者先问清楚。
     */
    const out = names([
      exam('血常规', 'LAB', null),
      exam('心电图', 'EXAM', false),
    ]);
    expect(out).toEqual(['心电图', '血常规']);
  });

  it('空腹未知的预约影像仍排在普通项目之前，但同样要确认', () => {
    /*
     * 这是刻意的例外：CT 的优先级来自"要排号等很久"，与空腹无关；
     * 检查单上几乎不会给 CT 写"无需空腹"，若因此把它压到最后，
     * 最主要的场景反而失效了。提示照样保留。
     */
    const steps = planExamSequence([
      exam('心电图', 'EXAM', false),
      exam('胸部 CT 平扫', 'EXAM', null),
    ]);
    expect(steps[0]?.exam.name).toBe('胸部 CT 平扫');
    expect(steps[0]?.needsConfirmation).toBe(true);
  });
});

describe('planExamSequence：边界', () => {
  it('空数组返回空数组，不编步骤', () => {
    expect(planExamSequence([])).toEqual([]);
  });

  it('单个项目就是第 1 步', () => {
    const steps = planExamSequence([exam('血常规', 'LAB', false)]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.order).toBe(1);
    expect(steps[0]?.reason).toBeTruthy();
  });

  it('编号从 1 连续递增', () => {
    const steps = planExamSequence([
      exam('血常规', 'LAB', null),
      exam('空腹血糖', 'LAB', true),
      exam('胸部 CT', 'EXAM', false),
    ]);
    expect(steps.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  it('同档内保持检查单原顺序（稳定，方便患者对照单子）', () => {
    const out = names([
      exam('血常规', 'LAB', false),
      exam('心电图', 'EXAM', false),
      exam('腹部彩超', 'EXAM', false),
      exam('尿常规', 'LAB', false),
    ]);
    expect(out).toEqual(['血常规', '心电图', '腹部彩超', '尿常规']);
  });

  it('多个空腹抽血之间也保持原顺序', () => {
    const out = names([
      exam('空腹血糖', 'LAB', true),
      exam('甲状腺功能', 'LAB', true),
      exam('血脂', 'LAB', true),
    ]);
    expect(out).toEqual(['空腹血糖', '甲状腺功能', '血脂']);
  });

  it('不改写传入的项目对象', () => {
    const input = [exam('血常规', 'LAB', null), exam('空腹血糖', 'LAB', true)];
    const snapshot = input.map((e) => ({ ...e }));
    planExamSequence(input);
    expect(input).toEqual(snapshot);
  });
});
