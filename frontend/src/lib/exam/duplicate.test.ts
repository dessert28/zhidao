/* ------------------------------------------------------------------
 * 跨院重复检查检测测试
 *
 * 这个功能的失败形态很危险：**误报**会让患者以为医院在乱开检查
 * （医患关系问题），**漏报**则失去价值。所以两个方向都要测。
 *
 * 三条判定条件是"与"关系，最容易写错的是：
 *   · 同院两次被当成重复
 *   · 超出时效窗口仍被提示
 *   · 一条记录里有多个项目时算漏
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { detectDuplicateExams, EXAM_ITEM_NAMES, type RecordLike } from './duplicate';

const rec = (
  id: number,
  hospitalCode: string,
  visitDate: string,
  ocrText: string,
): RecordLike => ({ id, hospitalCode, visitDate, ocrText });

describe('基本检测', () => {
  it('跨院两次糖化血红蛋白（38 天）被检出', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-09-12', '糖化血红蛋白 7.8%'),
      rec(2, 'MOCK-B', '2026-10-20', '本次未重复开具糖化血红蛋白'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.item).toBe('糖化血红蛋白');
    expect(out[0]!.gapDays).toBe(38);
  });

  it('结论文案给的是建议而不是指控', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-09-12', '糖化血红蛋白 7.8%'),
      rec(2, 'MOCK-B', '2026-10-20', '糖化血红蛋白复查'),
    ]);
    // 不能说"你被重复检查了""不用再查了"这类话
    expect(out[0]!.message).toContain('可以告诉医生');
    expect(out[0]!.message).not.toMatch(/重复检查了|不用再查|没必要/);
  });
});

describe('不该报的三种情况', () => {
  it('同一家医院做两次不算跨院重复', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-09-12', '空腹血糖 8.4'),
      rec(2, 'MOCK-A', '2026-10-01', '空腹血糖 7.1'),
    ]);
    expect(out).toHaveLength(0);
  });

  it('超出时效窗口不报（糖化血红蛋白 90 天窗口）', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-01-01', '糖化血红蛋白 7.8%'),
      rec(2, 'MOCK-B', '2026-09-01', '糖化血红蛋白 7.2%'), // 隔 243 天
    ]);
    expect(out).toHaveLength(0);
  });

  it('只有一次不报', () => {
    const out = detectDuplicateExams([rec(1, 'MOCK-A', '2026-09-12', '糖化血红蛋白 7.8%')]);
    expect(out).toHaveLength(0);
  });
});

describe('边界', () => {
  it('刚好等于窗口上限时报（边界包含）', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-01-01', '糖化血红蛋白 7.8%'),
      rec(2, 'MOCK-B', '2026-04-01', '糖化血红蛋白 7.2%'), // 恰好 90 天
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.gapDays).toBe(90);
  });

  it('超出窗口 1 天就不报', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-01-01', '糖化血红蛋白 7.8%'),
      rec(2, 'MOCK-B', '2026-04-02', '糖化血红蛋白 7.2%'), // 91 天
    ]);
    expect(out).toHaveLength(0);
  });

  it('同一天两家医院都做过 → gap=0，仍算重复', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-10-01', '空腹血糖 8.0'),
      rec(2, 'MOCK-B', '2026-10-01', '空腹血糖 7.5'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.gapDays).toBe(0);
    expect(out[0]!.message).toContain('同一天');
  });

  it('一条记录含多个项目时，各自按自己的窗口判定', () => {
    /*
     * 这里刻意用 38 天的间隔：
     *   糖化血红蛋白窗口 90 天 → 报告
     *   肝功能窗口 90 天       → 报告
     *   空腹血糖窗口 30 天     → **不报告**（38 天已超窗口）
     *
     * 第一版用例期望三个都报，是测试自己错了 ——
     * 空腹血糖一个月内重查才值得提示，38 天属于正常随访间隔。
     * 这个用例因此同时验证了"多项目独立计窗口"这件事。
     */
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-09-12', '空腹血糖 8.4，糖化血红蛋白 7.8%，肝功能正常'),
      rec(2, 'MOCK-B', '2026-10-20', '空腹血糖 7.9，糖化血红蛋白 7.2%，肝功能复查'),
    ]);
    const items = out.map((f) => f.item).sort();
    // 用集合比较而不是数组相等：默认 sort 按 Unicode 码位排，
    // 中文的顺序不符合直觉（'肝' 在 '糖' 之后），
    // 断言顺序等于在测字符串编码而不是测行为。
    expect(new Set(items)).toEqual(new Set(['肝功能', '糖化血红蛋白']));
    expect(items).not.toContain('空腹血糖');
  });

  it('空腹血糖在 30 天内跨院重查才报', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-10-01', '空腹血糖 8.4'),
      rec(2, 'MOCK-B', '2026-10-20', '空腹血糖 7.9'), // 19 天，窗口内
    ]);
    expect(out.map((f) => f.item)).toContain('空腹血糖');
  });

  it('空文本记录不产生任何命中', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-09-12', ''),
      rec(2, 'MOCK-B', '2026-10-20', ''),
    ]);
    expect(out).toHaveLength(0);
  });

  it('空记录列表不崩', () => {
    expect(detectDuplicateExams([])).toEqual([]);
  });

  it('日期非法时不抛异常', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', 'not-a-date', '空腹血糖 8.0'),
      rec(2, 'MOCK-B', '2026-10-20', '空腹血糖 7.5'),
    ]);
    // 间隔算不出 → 视为超出窗口，不报
    expect(out).toHaveLength(0);
  });
});

describe('排序与多组', () => {
  it('间隔最短的排在前面（最值得先提示）', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-09-01', '糖化血红蛋白 7.8%'),
      rec(2, 'MOCK-B', '2026-11-01', '糖化血红蛋白 7.2%'), // 61 天
      rec(3, 'MOCK-A', '2026-10-01', '空腹血糖 8.0'),
      rec(4, 'MOCK-B', '2026-10-05', '空腹血糖 7.5'), // 4 天
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.item).toBe('空腹血糖');
    expect(out[1]!.item).toBe('糖化血红蛋白');
  });

  it('同一项目三条记录时取最接近的跨院对', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-09-01', '空腹血糖 8.0'),
      rec(2, 'MOCK-A', '2026-09-20', '空腹血糖 7.8'), // 同院，不算
      rec(3, 'MOCK-B', '2026-09-25', '空腹血糖 7.5'), // 与 id=1 隔 24 天，与 id=2 隔 5 天
    ]);
    expect(out).toHaveLength(1);
    // 最近的一对是 MOCK-A(9-20) 与 MOCK-B(9-25)，隔 5 天
    expect(out[0]!.gapDays).toBe(5);
  });
});

describe('词典覆盖', () => {
  it('覆盖了常见且有复查周期的项目', () => {
    for (const name of ['糖化血红蛋白', '空腹血糖', '血脂', '肝功能', '肾功能']) {
      expect(EXAM_ITEM_NAMES).toContain(name);
    }
  });

  it('不同叫法都能识别', () => {
    const out = detectDuplicateExams([
      rec(1, 'MOCK-A', '2026-09-01', 'HbA1c 7.8%'),
      rec(2, 'MOCK-B', '2026-10-01', '糖化血红蛋白 7.2%'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.item).toBe('糖化血红蛋白');
  });
});
