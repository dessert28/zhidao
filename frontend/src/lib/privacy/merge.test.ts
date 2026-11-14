/* ------------------------------------------------------------------
 * 合并逻辑测试
 *
 * 这是端侧模型链路里**唯一能在 CI 里跑的部分**（模型本身要 129MB 权重）。
 * 所以这里测得细一些：合并若出错，表现是"遮掉了错误的字符"，
 * 比模型精度不足危险得多。
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { applyHits, mergeHits, type ModelEntityLike } from './merge';
import { redact } from './redact';

const hit = (type: 'name' | 'phone', start: number, end: number) => ({
  type,
  start,
  end,
  placeholder: type === 'name' ? '［患者姓名］' : '138****5678',
});

const ent = (type: 'name' | 'address', start: number, end: number, text = ''): ModelEntityLike => ({
  type,
  start,
  end,
  text,
});

describe('mergeHits：规则优先于模型', () => {
  it('模型没结果时原样返回规则结果', () => {
    const rule = [hit('phone', 0, 11)];
    expect(mergeHits(rule, null)).toEqual(rule);
    expect(mergeHits(rule, [])).toEqual(rule);
  });

  it('区间重叠时保留规则结果，不用模型覆盖', () => {
    // 规则认定 [0,11) 是手机号；模型说 [2,5) 是人名 —— 重叠，必须保留手机号
    const out = mergeHits([hit('phone', 0, 11)], [ent('name', 2, 5)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('phone');
  });

  it('不重叠的模型结果被追加（宁可多遮）', () => {
    const out = mergeHits([hit('phone', 10, 21)], [ent('name', 0, 2)]);
    expect(out).toHaveLength(2);
    expect(out.map((h) => h.type).sort()).toEqual(['name', 'phone']);
  });

  it('模型结果带上对应占位符', () => {
    const out = mergeHits([], [ent('name', 0, 2), ent('address', 5, 8)]);
    expect(out.find((h) => h.type === 'name')!.placeholder).toBe('［患者姓名］');
    expect(out.find((h) => h.type === 'address')!.placeholder).toBe('［住址已遮蔽］');
  });
});

describe('mergeHits：结果必须可按位置切原文', () => {
  it('输出按 start 升序', () => {
    const out = mergeHits([hit('phone', 20, 31), hit('name', 5, 7)], [ent('address', 12, 15)]);
    const starts = out.map((h) => h.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('输出区间互不重叠', () => {
    const out = mergeHits([hit('phone', 0, 11)], [ent('name', 3, 6), ent('address', 20, 25)]);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.end);
    }
  });

  it('丢弃非法区间（倒序 / 负下标），不让它污染输出', () => {
    const out = mergeHits([], [ent('name', 5, 5), ent('name', 9, 3), ent('name', -2, 4)]);
    expect(out).toHaveLength(0);
  });
});

describe('applyHits：按遮蔽列表重建文本', () => {
  it('单处遮蔽', () => {
    const raw = '我叫张三，你好';
    const out = applyHits(raw, [{ type: 'name', start: 2, end: 4, placeholder: '［患者姓名］' }]);
    expect(out).toBe('我叫［患者姓名］，你好');
  });

  it('多处遮蔽，位置不漂移', () => {
    const raw = '张三的电话是13812345678，谢谢';
    const out = applyHits(raw, [
      { type: 'name', start: 0, end: 2, placeholder: '［患者姓名］' },
      { type: 'phone', start: 6, end: 17, placeholder: '138****5678' },
    ]);
    expect(out).toBe('［患者姓名］的电话是138****5678，谢谢');
  });

  it('无命中时原样返回', () => {
    expect(applyHits('你好', [])).toBe('你好');
  });

  it('重叠区间被跳过，不回头', () => {
    const raw = 'abcdefghij';
    const out = applyHits(raw, [
      { type: 'name', start: 0, end: 4, placeholder: 'X' },
      { type: 'name', start: 2, end: 6, placeholder: 'Y' },
    ]);
    expect(out).toBe('Xefghij');
  });
});

describe('与规则引擎联调', () => {
  it('规则结果 + 模型结果合并后，原文里所有字位置正确', () => {
    const raw = '我是老王，手机13812345678';
    const rule = redact(raw);

    // 模型把「老王」标成人名（规则抓不到，因为没有"我叫/患者"前缀）
    const model: ModelEntityLike[] = [{ type: 'name', start: 3, end: 5, text: '老王' }];

    const merged = mergeHits(rule.hits, model);
    const out = applyHits(raw, merged);

    expect(out).toContain('［患者姓名］');
    expect(out).toContain('138****5678');
    // 原文里的手机号不能残留
    expect(out).not.toContain('13812345678');
  });

  it('规则已经抓到的姓名，模型再标一次不会产生两处遮蔽', () => {
    const raw = '我叫张三';
    const rule = redact(raw);
    expect(rule.hits).toHaveLength(1);

    const model: ModelEntityLike[] = [{ type: 'name', start: 3, end: 5, text: '张三' }];
    const merged = mergeHits(rule.hits, model);

    expect(merged).toHaveLength(1);
    expect(applyHits(raw, merged)).toBe('我叫［患者姓名］');
  });
});
