/* ------------------------------------------------------------------
 * 出站上下文测试 —— 「随问题一起发出去的那段话，也要过脱敏」
 *
 * 这类 bug 的共同点是：它只在某个字段里**恰好**出现 PII 时才发作，
 * 平时跑一百遍都看不出来。所以这里直接把 PII 塞进档案摘要里断言。
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { composeRequestText } from './context';

describe('composeRequestText：上下文同样经过脱敏', () => {
  it('问题里的个人信息被遮蔽', async () => {
    const out = await composeRequestText('', '我电话 13812345678，最近头晕');
    expect(out.text).not.toContain('13812345678');
    expect(out.text).toContain('138****5678');
  });

  it('档案摘要里的电话、身份证、病历号同样被遮蔽（回归：原来完全不处理）', async () => {
    const context =
      '【我的健康档案】62 岁；慢病：高血压；随访电话 13812345678；病历号 BJ20240017';
    const out = await composeRequestText(context, '我能吃柚子吗');

    expect(out.text).not.toContain('13812345678');
    expect(out.text).not.toContain('BJ20240017');
    expect(out.text).toContain('138****5678');
    expect(out.contextMasked).toBe(true);
  });

  it('上下文在前、问题在后，顺序与原实现一致', async () => {
    const out = await composeRequestText('【我的健康档案】62 岁', '我能吃什么');
    expect(out.text).toBe('【我的健康档案】62 岁\n\n我能吃什么');
  });

  it('没有档案时不加前缀，也不留下多余的换行', async () => {
    const out = await composeRequestText('', '我能吃什么');
    expect(out.text).toBe('我能吃什么');
    expect(out.contextMasked).toBe(false);
  });

  it('只有档案、没有问题时不拼出悬空的分隔', async () => {
    const out = await composeRequestText('【我的健康档案】62 岁', '');
    expect(out.text).toBe('【我的健康档案】62 岁');
  });

  it('两部分各自遮蔽，互不串位', async () => {
    const out = await composeRequestText('档案：13812345678', '问题：13912345678');
    expect(out.text).toBe('档案：138****5678\n\n问题：139****5678');
    expect(out.maskedHits).toBe(2);
  });
});
