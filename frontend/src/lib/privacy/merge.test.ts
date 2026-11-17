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

const hit = (type: 'address' | 'phone', start: number, end: number) => ({
  type,
  start,
  end,
  placeholder: type === 'address' ? '［住址已遮蔽］' : '138****5678',
});

const ent = (
  type: 'address' | 'phone',
  start: number,
  end: number,
  text = '',
): ModelEntityLike => ({
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
    // 规则认定 [0,11) 是手机号；模型说 [2,5) 是地名 —— 重叠，必须保留手机号
    const out = mergeHits([hit('phone', 0, 11)], [ent('address', 2, 5)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('phone');
  });

  it('不重叠的模型结果被追加（宁可多遮）', () => {
    const out = mergeHits([hit('phone', 10, 21)], [ent('address', 0, 2)]);
    expect(out).toHaveLength(2);
    expect(out.map((h) => h.type).sort()).toEqual(['address', 'phone']);
  });

  it('模型结果带上对应占位符', () => {
    const out = mergeHits([], [ent('address', 0, 3), ent('phone', 5, 8)]);
    expect(out.find((h) => h.type === 'address')!.placeholder).toBe('［住址已遮蔽］');
    expect(out.find((h) => h.type === 'phone')!.placeholder).toBe('［手机号已遮蔽］');
  });
});

describe('mergeHits：结果必须可按位置切原文', () => {
  it('输出按 start 升序', () => {
    const out = mergeHits([hit('phone', 20, 31), hit('address', 5, 7)], [ent('address', 12, 15)]);
    const starts = out.map((h) => h.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('输出区间互不重叠', () => {
    const out = mergeHits([hit('phone', 0, 11)], [ent('address', 3, 6), ent('address', 20, 25)]);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.end);
    }
  });

  it('丢弃非法区间（倒序 / 负下标），不让它污染输出', () => {
    const out = mergeHits([], [ent('address', 5, 5), ent('address', 9, 3), ent('address', -2, 4)]);
    expect(out).toHaveLength(0);
  });
});

describe('applyHits：按遮蔽列表重建文本', () => {
  it('单处遮蔽', () => {
    const raw = '住桐梓路8号，你好';
    const out = applyHits(raw, [{ type: 'address', start: 1, end: 6, placeholder: '［住址已遮蔽］' }]);
    expect(out).toBe('住［住址已遮蔽］，你好');
  });

  it('多处遮蔽，位置不漂移', () => {
    const raw = '住桐梓路8号，电话13812345678';
    const out = applyHits(raw, [
      { type: 'address', start: 1, end: 6, placeholder: '［住址已遮蔽］' },
      { type: 'phone', start: 9, end: 20, placeholder: '138****5678' },
    ]);
    expect(out).toBe('住［住址已遮蔽］，电话138****5678');
  });

  it('无命中时原样返回', () => {
    expect(applyHits('你好', [])).toBe('你好');
  });

  it('重叠区间被跳过，不回头', () => {
    const raw = 'abcdefghij';
    const out = applyHits(raw, [
      { type: 'address', start: 0, end: 4, placeholder: 'X' },
      { type: 'address', start: 2, end: 6, placeholder: 'Y' },
    ]);
    expect(out).toBe('Xefghij');
  });
});

describe('与规则引擎联调', () => {
  it('规则结果 + 模型结果合并后，原文里所有字位置正确', () => {
    const raw = '我住梧桐里社区，手机13812345678';
    const rule = redact(raw);

    // 模型把「梧桐里」标成地名（规则只认"X区/县 + 路/街"，抓不到这种写法）
    const s = raw.indexOf('梧桐里');
    const model: ModelEntityLike[] = [{ type: 'address', start: s, end: s + 3, text: '梧桐里' }];

    const merged = mergeHits(rule.hits, model);
    const out = applyHits(raw, merged);

    expect(out).toContain('［住址已遮蔽］');
    expect(out).toContain('138****5678');
    // 原文里的手机号不能残留
    expect(out).not.toContain('13812345678');
  });

  it('模型与规则落在同一段上时只留一处遮蔽（按规则结果）', () => {
    const raw = '手机13812345678';
    const rule = redact(raw);
    expect(rule.hits).toHaveLength(1);

    const model: ModelEntityLike[] = [{ type: 'phone', start: 2, end: 13, text: '13812345678' }];
    const merged = mergeHits(rule.hits, model);

    expect(merged).toHaveLength(1);
    expect(applyHits(raw, merged)).toBe('手机138****5678');
  });
});
