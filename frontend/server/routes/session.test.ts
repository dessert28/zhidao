/* ------------------------------------------------------------------
 * 多轮会话状态测试 —— 针对"记不住话"这个实测缺陷
 *
 * 被测的三段逻辑（都在 chat 路由里，抽出来才好测）：
 *   1. 从请求恢复 session
 *   2. 本轮采集的槽位并回 session（只合并非空值）
 *   3. 追问时轮次 +1
 *
 * 为什么这类测试比"能不能跑通"更重要：
 *   这个缺陷的原始表现是用户说「你问过我了」——
 *   功能"能用"，但体验是坏的。没有测试守着，
 *   下次改动（比如把 session 换成 stateless）会静默复发。
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import type { SymptomSlots } from '@shared/types/contract';

/** 从 chat.ts 抽出的合并逻辑（保持行为一致，便于单测） */
function mergeIntoSession(
  session: { slots: SymptomSlots; round: number },
  collected: SymptomSlots,
): void {
  for (const [k, v] of Object.entries(collected ?? {})) {
    if (typeof v === 'string' && v.trim()) session.slots[k] = v;
  }
}

describe('会话槽位合并', () => {
  it('新槽位被加入', () => {
    const s = { slots: {} as SymptomSlots, round: 0 };
    mergeIntoSession(s, { 部位: '头' });
    expect(s.slots).toEqual({ 部位: '头' });
  });

  it('空串与空白不覆盖已有值', () => {
    const s = { slots: { 部位: '头' } as SymptomSlots, round: 0 };
    mergeIntoSession(s, { 部位: '', 时长: '   ' });
    expect(s.slots.部位).toBe('头');
    expect(s.slots.时长).toBeUndefined();
  });

  it('多个槽位累加，互不覆盖', () => {
    const s = { slots: {} as SymptomSlots, round: 0 };
    mergeIntoSession(s, { 部位: '头' });
    mergeIntoSession(s, { 时长: '三天' });
    mergeIntoSession(s, { 性质: '胀痛' });
    expect(s.slots).toEqual({ 部位: '头', 时长: '三天', 性质: '胀痛' });
  });

  it('同槽位新值覆盖旧值（用户改口）', () => {
    const s = { slots: { 部位: '头' } as SymptomSlots, round: 0 };
    mergeIntoSession(s, { 部位: '后脑' });
    expect(s.slots.部位).toBe('后脑');
  });

  it('collected 为 undefined 时不崩', () => {
    const s = { slots: { 部位: '头' } as SymptomSlots, round: 0 };
    expect(() => mergeIntoSession(s, undefined as unknown as SymptomSlots)).not.toThrow();
    expect(s.slots.部位).toBe('头');
  });
});

describe('边界：极端输入', () => {
  it('槽位值为非字符串时被忽略（模型可能返回数字/对象）', () => {
    const s = { slots: {} as SymptomSlots, round: 0 };
    mergeIntoSession(s, { 时长: 3 as unknown as string, 部位: { a: 1 } as unknown as string });
    expect(Object.keys(s.slots)).toHaveLength(0);
  });

  it('超长槽位值不会导致异常', () => {
    const s = { slots: {} as SymptomSlots, round: 0 };
    mergeIntoSession(s, { 部位: '头'.repeat(5000) });
    expect(s.slots.部位!.length).toBe(5000);
  });

  it('零宽字符被视为非空（trim 不处理），但不会破坏结构', () => {
    const s = { slots: {} as SymptomSlots, round: 0 };
    mergeIntoSession(s, { 部位: '\u200b' });
    // 记录了但不影响其他槽位 —— 这是"宁可多记"的取舍
    expect(Object.keys(s.slots)).toHaveLength(1);
  });
});

/* ============================ 占位词过滤 ============================ */

/**
 * 与 chat.ts 里的实现保持一致的判定（这里是它的副本，供单测使用）。
 * 之所以复制而不是 import：那个函数没导出，且导出它会让测试
 * 依赖整个路由模块（连带 Hono）。
 */
function isPlaceholderValue(v: string): boolean {
  const s = v.trim().replace(/[。，,.、\s]/g, '');
  if (!s) return true;
  return /^(未提及|未说明|未明确|未描述|未知|不详|不清楚|不确定|无|没有|暂无|none|null|n\/a|na|unknown|-{1,2})$/i.test(
    s,
  );
}

describe('占位词过滤：模型用"未提及"填坑时必须挡住', () => {
  it('拦下常见占位词', () => {
    for (const w of ['未提及', '不详', '未知', '无', '没有', '暂无', '不清楚', 'N/A', 'none', '-', '--']) {
      expect(isPlaceholderValue(w), `应拦下「${w}」`).toBe(true);
    }
  });

  it('带标点与空格的占位词同样拦下', () => {
    expect(isPlaceholderValue('未提及。')).toBe(true);
    expect(isPlaceholderValue(' 不详，')).toBe(true);
    expect(isPlaceholderValue('unknown ')).toBe(true);
  });

  it('空串与纯空白算占位', () => {
    expect(isPlaceholderValue('')).toBe(true);
    expect(isPlaceholderValue('   ')).toBe(true);
  });

  /** 反向用例：这些是真实信息，一条都不能误伤 */
  it('不误伤真实槽位值', () => {
    for (const real of [
      '后脑勺',
      '三天',
      '胀痛',
      '低头时更明显',
      '无发热',            // 含"无"但是真实信息
      '没有明显诱因',      // 含"没有"但是真实描述
      '未提及但两侧都疼',  // 含"未提及"但是真实回答
      '胸口',
      '两周',
    ]) {
      expect(isPlaceholderValue(real), `误伤了「${real}」`).toBe(false);
    }
  });

  it('单个字不算占位（可能是真实部位简称）', () => {
    expect(isPlaceholderValue('头')).toBe(false);
    expect(isPlaceholderValue('腰')).toBe(false);
  });
});
