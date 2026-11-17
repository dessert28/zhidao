/* ------------------------------------------------------------------
 * 检查单解析的测试
 *
 * 这份解析结果会直接驱动"下一步去哪"，所以**错一个就是把人指错楼**。
 * 重点测三类：
 *   1. 常见检查单版式能不能抽出项目
 *   2. 空腹判断：不知道 ≠ 不需要
 *   3. 抽不到时返回空数组，而不是瞎猜
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import {
  groupByPlaceType,
  hasUnknownFasting,
  needsFastingOverall,
  parseExamOrder,
} from './order-parse';

describe('parseExamOrder：常见版式', () => {
  it('一行一项的检查单', () => {
    const out = parseExamOrder(`
检查项目：
胸部 CT 平扫
腹部彩超
血常规
`);
    const names = out.map((e) => e.name);
    // 词典命中的项目输出标准名（与跨院重复检查共用一套名字）；
    // 认不出的才回退原文，所以这里不再是「胸部 CT 平扫」「腹部彩超」
    expect(names).toContain('胸部CT');
    expect(names).toContain('腹部超声');
    expect(names).toContain('血常规');
  });

  it('带「检查名称：」前缀也能抠出名字', () => {
    const out = parseExamOrder('检查名称：心电图');
    expect(out).toHaveLength(1);
    // 前缀不该被当成项目名的一部分
    expect(out[0]?.name).not.toContain('检查名称');
  });

  it('词典里的标准项目走标准名', () => {
    const out = parseExamOrder('空腹血糖、糖化血红蛋白');
    const names = out.map((e) => e.name);
    expect(names).toContain('空腹血糖');
    expect(names).toContain('糖化血红蛋白');
  });

  it('归到正确的站：影像 → EXAM，抽血 → LAB', () => {
    const out = parseExamOrder('胸部 CT\n血常规');
    const g = groupByPlaceType(out);
    expect(g.exam.length).toBeGreaterThan(0);
    expect(g.lab.length).toBeGreaterThan(0);
  });

  it('同一张单子上重复出现的项目只算一次', () => {
    const out = parseExamOrder('血常规\n血常规');
    expect(out.filter((e) => e.name === '血常规')).toHaveLength(1);
  });
});

describe('parseExamOrder：空腹判断', () => {
  it('明确写空腹 → true', () => {
    const out = parseExamOrder('空腹血糖');
    expect(out[0]?.fasting).toBe(true);
  });

  it('明确写无需空腹 → false', () => {
    const out = parseExamOrder('腹部彩超（无需空腹）');
    expect(out[0]?.fasting).toBe(false);
  });

  it('没写 → null，不是 false', () => {
    /*
     * 这是整个模块最重要的一条。
     * null 表示"我们不知道，界面要提示患者确认"；
     * false 表示"确认不需要空腹"。
     * 把不知道当不需要，患者会吃完饭才去做需要空腹的检查 —— 当天白跑。
     */
    const out = parseExamOrder('血常规');
    expect(out[0]?.fasting).toBeNull();
  });

  it('独立的「空腹」备注行能作用到下一项', () => {
    const out = parseExamOrder('空腹\n腹部彩超');
    expect(out[0]?.fasting).toBe(true);
  });

  it('上一行是另一个项目时，不把它的空腹套过来', () => {
    /*
     * "空腹血糖"下面一行是"胸部 CT"。
     * 如果无脑继承上一行的空腹状态，胸部 CT 会被误判为需要空腹。
     */
    const out = parseExamOrder('空腹血糖\n胸部 CT 平扫');
    const ct = out.find((e) => e.name.includes('CT'));
    expect(ct?.fasting).not.toBe(true);
  });

  it('needsFastingOverall：任一项目要空腹就是 true', () => {
    expect(needsFastingOverall(parseExamOrder('空腹血糖'))).toBe(true);
    expect(needsFastingOverall(parseExamOrder('血常规'))).toBe(false);
  });

  it('hasUnknownFasting：有不确定的项目就提示', () => {
    expect(hasUnknownFasting(parseExamOrder('血常规'))).toBe(true);
    expect(hasUnknownFasting(parseExamOrder('腹部彩超（无需空腹）'))).toBe(false);
  });
});

describe('parseExamOrder：不假装成功', () => {
  it('空文本返回空数组', () => {
    expect(parseExamOrder('')).toEqual([]);
    expect(parseExamOrder('   \n\n  ')).toEqual([]);
  });

  it('认不出的内容返回空数组，而不是编一个', () => {
    const out = parseExamOrder('遵医嘱执行\n注意休息');
    expect(out).toEqual([]);
  });

  it('evidence 保留原文片段，供患者核对', () => {
    const out = parseExamOrder('检查名称：胸部 CT 平扫');
    expect(out[0]?.evidence).toContain('胸部 CT');
  });
});
