/* ------------------------------------------------------------------
 * 生成式 UI 渲染字典测试
 *
 * 这层的特殊性：renderEventToHtml **吞掉所有异常返回 null**，
 * 这是有意的（卡片挂掉不该中断 SSE），代价是 bug 会静默。
 * 所以必须有测试逐类型验证"真的渲染出内容"，
 * 否则某个卡片悄悄变成空白，线上没人发现。
 *
 * 曾经踩过的坑（已固化为用例）:
 *   style 传字符串 → React 抛异常 → 被吞 → 卡片空白
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { isRenderable, renderEventToHtml } from './registry';

describe('注册表分发', () => {
  it.each(['department_card', 'emergency', 'caveat', 'timeline_card', 'review_trace', 'tool_result'])(
    '%s 已注册',
    (t) => {
      expect(isRenderable(t)).toBe(true);
    },
  );

  it('未注册类型返回 false', () => {
    expect(isRenderable('token')).toBe(false);
  });

  it('未注册类型渲染返回 null', () => {
    expect(renderEventToHtml('token', {})).toBeNull();
  });
});

describe('每种卡片都真的渲染出内容', () => {
  it('department_card', () => {
    const html = renderEventToHtml('department_card', {
      departments: [
        { name: '消化内科', confidence: 0.72, reason: '症状指向消化系统' },
        { name: '全科医学科', confidence: 0.3, reason: '不确定时可先看全科' },
      ],
    });
    expect(html).toBeTruthy();
    expect(html).toContain('消化内科');
    expect(html).toContain('72%');
  });

  it('department_card 空列表给兜底话术', () => {
    const html = renderEventToHtml('department_card', { departments: [] });
    expect(html).toContain('导诊台');
  });

  it('emergency', () => {
    const html = renderEventToHtml('emergency', {
      redFlag: { type: 'chest_pain', guidance: '请立即停止活动并拨打 120' },
    });
    expect(html).toBeTruthy();
    expect(html).toContain('120');
    expect(html).toContain('胸痛');
  });

  it('caveat', () => {
    const html = renderEventToHtml('caveat', { text: '本回答不构成诊断建议' });
    expect(html).toContain('不构成诊断建议');
  });

  it('timeline_card', () => {
    const html = renderEventToHtml('timeline_card', {
      tasks: [
        { order: 1, task: '带身份证', dependsOn: [], note: '' },
        { order: 4, task: '空腹抽血', dependsOn: [], note: '前一天 22 点后禁食' },
      ],
    });
    expect(html).toBeTruthy();
    expect(html).toContain('带身份证');
    expect(html).toContain('禁食');
  });

  it('review_trace', () => {
    const html = renderEventToHtml('review_trace', {
      scores: { safety: 1, accuracy: 0.75, completeness: 0.75, groundedness: 0.85 },
      action: 'pass',
    });
    expect(html).toBeTruthy();
    expect(html).toContain('安全');
    expect(html).toContain('依据');
  });

  it('tool_result 带 sources 时渲染引用卡', () => {
    const html = renderEventToHtml('tool_result', {
      name: 'hybrid_search',
      ok: true,
      result: {
        count: 2,
        sources: [
          { docId: 'kb-001', title: '空腹血糖偏高的就诊建议', snippet: '正常范围 3.9–6.1', score: 1 },
          { docId: 'kb-002', title: '血压偏高时的就诊准备', snippet: '上限 140/90', score: 0.4 },
        ],
      },
    });
    // 这条用例专门锁住 style 对象化的修复：
    // style 传字符串会让 React 抛异常并被吞成 null
    expect(html).toBeTruthy();
    expect(html).toContain('空腹血糖偏高的就诊建议');
    expect(html).toContain('依据 2 篇资料');
    expect(html).toContain('width:100%');
  });

  it('tool_result 无 sources 时渲染空串而非 null 异常', () => {
    const html = renderEventToHtml('tool_result', {
      name: 'other_tool',
      ok: true,
      result: { foo: 1 },
    });
    // 空 fragment 渲染成空串，不应是 null（null 说明抛异常了）
    expect(html).toBe('');
  });
});

describe('渲染安全性', () => {
  it('用户文本被转义，不能注入标签', () => {
    const html = renderEventToHtml('caveat', {
      text: '<img src=x onerror=alert(1)>',
    });
    expect(html).toBeTruthy();
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('科室名里的尖括号也被转义', () => {
    const html = renderEventToHtml('department_card', {
      departments: [{ name: '<script>x</script>', confidence: 0.5, reason: 'r' }],
    });
    expect(html).not.toContain('<script>');
  });
});

describe('健壮性', () => {
  it('缺字段不抛异常，返回 null 或空', () => {
    expect(() => renderEventToHtml('department_card', {})).not.toThrow();
    expect(() => renderEventToHtml('emergency', {})).not.toThrow();
    expect(() => renderEventToHtml('review_trace', {})).not.toThrow();
  });
});
