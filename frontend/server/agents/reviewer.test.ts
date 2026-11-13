/* ------------------------------------------------------------------
 * Reviewer 的测试 —— 重点验证「规则优先于分数」与「失败要保守」
 * ------------------------------------------------------------------ */

import { describe, expect, it, vi } from 'vitest';
import {
  allergyCrosscheck,
  applySafetyRules,
  belowThreshold,
  DEFAULT_THRESHOLDS,
  drugConflictCheck,
  GENERIC_CAVEAT,
  LOW_SCORE_STREAK_LIMIT,
  makeReviewer,
  overallScore,
  ruleBasedScores,
  sanitizeAnswer,
} from './reviewer.js';
import type { AgentInput, SessionFacts } from '@shared/types/contract';

const facts = (over: Partial<SessionFacts> = {}): SessionFacts => ({
  allergies: [],
  chronicConditions: [],
  currentMedications: [],
  bookingState: null,
  ...over,
});

const input = (
  payload: { candidateAnswer: string; evidenceCount?: number; lowScoreStreak?: number },
  f: SessionFacts = facts(),
): AgentInput<{ candidateAnswer: string; evidenceCount?: number; lowScoreStreak?: number }> => ({
  turnId: 't1',
  sessionId: 's1',
  userId: 'u1',
  payload,
  facts: f,
  memory: { window: [], summary: null, semanticHits: [] },
});

describe('安全规则：诊断结论', () => {
  it('「你这是胃炎」被改写', () => {
    const r = applySafetyRules('你这是胃炎，吃点药就好');
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.answer).not.toContain('你这是胃炎');
    expect(r.answer).toContain('医生面诊确认');
  });

  it('「确诊为糖尿病」被改写', () => {
    const r = applySafetyRules('根据指标可以确诊为糖尿病');
    expect(r.issues.some((i) => i.detail.includes('诊断'))).toBe(true);
  });

  it('正常描述不误伤', () => {
    const r = applySafetyRules('建议挂内分泌科，让医生看看你的血糖情况');
    expect(r.issues).toHaveLength(0);
  });
});

describe('安全规则：用药与剂量', () => {
  it('「建议吃点布洛芬」被改写', () => {
    const r = applySafetyRules('头疼的话建议吃点布洛芬');
    expect(r.issues.some((i) => i.type === 'unsafe')).toBe(true);
    expect(r.answer).not.toContain('建议吃点布洛芬');
  });

  it('给出具体剂量 → 整段拦截', () => {
    const r = applySafetyRules('可以每次 500mg 每日三次口服');
    expect(r.blocked).toBe(true);
    expect(r.issues.some((i) => i.action === 'blocked')).toBe(true);
  });

  it('「停药」被改写', () => {
    const r = applySafetyRules('你可以先停药观察几天');
    expect(r.answer).not.toContain('先停药');
    expect(r.answer).toContain('原开方医生');
  });

  it('「不用去看医生」被改写', () => {
    const r = applySafetyRules('这个不用去看医生，自己会好');
    expect(r.answer).toContain('让医生判断');
  });
});

describe('交叉检查：过敏', () => {
  it('答案提到过敏物 → 警示', () => {
    const r = allergyCrosscheck({
      answer: '可能需要用青霉素类抗生素',
      facts: facts({ allergies: ['青霉素'] }),
    });
    expect(r.issues).toHaveLength(1);
    expect(r.warnings[0]).toContain('青霉素');
  });

  it('答案没提到 → 无警示', () => {
    const r = allergyCrosscheck({
      answer: '建议挂呼吸内科',
      facts: facts({ allergies: ['青霉素'] }),
    });
    expect(r.warnings).toHaveLength(0);
  });

  it('无过敏记录 → 不检查', () => {
    const r = allergyCrosscheck({ answer: '青霉素', facts: facts() });
    expect(r.warnings).toHaveLength(0);
  });

  it('警示语只提示，不下判断', () => {
    const r = allergyCrosscheck({
      answer: '青霉素',
      facts: facts({ allergies: ['青霉素'] }),
    });
    // 不能出现"你不能用"这类判断
    expect(r.warnings[0]).not.toMatch(/不能(用|吃)|禁用|禁止/);
    expect(r.warnings[0]).toMatch(/告知医生|过敏史/);
  });
});

describe('交叉检查：用药冲突', () => {
  it('答案同时提到两种在用药 → 提示确认能否同服', () => {
    const r = drugConflictCheck({
      answer: '你目前在用二甲双胍和阿司匹林',
      facts: facts({ currentMedications: ['二甲双胍', '阿司匹林'] }),
    });
    expect(r.issues).toHaveLength(1);
    expect(r.warnings[0]).toContain('请');
    expect(r.warnings[0]).toContain('医生');
  });

  it('只提到一种 → 不提示', () => {
    const r = drugConflictCheck({
      answer: '你在用二甲双胍',
      facts: facts({ currentMedications: ['二甲双胍', '阿司匹林'] }),
    });
    expect(r.warnings).toHaveLength(0);
  });

  it('提示语不做相互作用判断', () => {
    const r = drugConflictCheck({
      answer: '二甲双胍和阿司匹林',
      facts: facts({ currentMedications: ['二甲双胍', '阿司匹林'] }),
    });
    expect(r.warnings[0]).not.toMatch(/会(导致|引起)|相互作用|禁忌/);
  });
});

describe('四维打分', () => {
  it('有安全问题 → safety 归零', () => {
    const s = ruleBasedScores('随便什么答案', 2, 1);
    expect(s.safety).toBe(0);
  });

  it('无问题 → safety 满分', () => {
    expect(ruleBasedScores('答案', 2, 0).safety).toBe(1);
  });

  it('证据越多 groundedness 越高', () => {
    const few = ruleBasedScores('答案', 0, 0).groundedness;
    const many = ruleBasedScores('答案', 3, 0).groundedness;
    expect(many).toBeGreaterThan(few);
  });

  it('overall 在 0-1 之间且 safety 权重最高', () => {
    const safe = overallScore({ safety: 1, accuracy: 0.5, completeness: 0.5, groundedness: 0.5 });
    const unsafe = overallScore({ safety: 0, accuracy: 1, completeness: 1, groundedness: 1 });
    expect(safe).toBeGreaterThan(unsafe);
    expect(unsafe).toBeLessThan(0.7);
  });

  it('阈值判断任一维度低于即不通过', () => {
    expect(
      belowThreshold(
        { safety: 0.9, accuracy: 0.9, completeness: 0.9, groundedness: 0.3 },
        DEFAULT_THRESHOLDS,
      ),
    ).toBe(true);
  });
});

describe('Reviewer 主流程', () => {
  it('干净答案 → ok，且必定带免责声明', async () => {
    const reviewer = makeReviewer();
    const out = await reviewer(
      input({ candidateAnswer: '建议挂内分泌科，注意记录空腹血糖', evidenceCount: 2 }),
    );

    expect(out.status).toBe('ok');
    expect(out.events.some((e) => e.type === 'caveat')).toBe(true);
    const caveat = out.payload.caveat ?? '';
    expect(caveat).toContain('不构成诊断');
  });

  it('安全规则命中 → 答案被改写，仍在 trace 里记录', async () => {
    const reviewer = makeReviewer();
    const out = await reviewer(
      input({ candidateAnswer: '你这是胃炎，建议吃点奥美拉唑', evidenceCount: 1 }),
    );

    expect(out.payload.issues.length).toBeGreaterThan(0);
    expect(out.payload.issues.some((i) => i.type === 'unsafe')).toBe(true);
  });

  it('剂量 → blocked，不给任何具体数值', async () => {
    const reviewer = makeReviewer();
    const out = await reviewer(
      input({ candidateAnswer: '每次 500mg 每日三次口服即可' }),
    );

    expect(out.status).toBe('blocked');
    expect(out.payload.overall).toBe(0);
  });

  it('红线复检 → blocked + emergency（最先执行）', async () => {
    const reviewer = makeReviewer();
    const out = await reviewer(input({ candidateAnswer: '这可能是胸痛引起的心梗' }));

    expect(out.status).toBe('blocked');
    expect(out.events.some((e) => e.type === 'emergency')).toBe(true);
  });

  it('过敏交叉检查产生 caveat 事件', async () => {
    const reviewer = makeReviewer();
    const out = await reviewer(
      input(
        { candidateAnswer: '可能需要青霉素', evidenceCount: 1 },
        facts({ allergies: ['青霉素'] }),
      ),
    );

    const caveats = out.events.filter((e) => e.type === 'caveat');
    expect(caveats.length).toBeGreaterThanOrEqual(2); // 过敏 + 通用免责
  });

  describe('规则优先于分数', () => {
    it('judge 打满分但命中安全规则 → safety 仍被压到 0', async () => {
      const reviewer = makeReviewer({
        judge: async () => ({ safety: 1, accuracy: 1, completeness: 1, groundedness: 1 }),
      });
      const out = await reviewer(
        input({ candidateAnswer: '你可以先停药观察', evidenceCount: 3 }),
      );

      // 规则命中 → safety 归零，judge 的 1 分压不住
      expect(out.payload.scores.safety).toBe(0);
    });
  });

  describe('失败要保守', () => {
    it('judge 抛错 → 仍用规则分，且带免责', async () => {
      const reviewer = makeReviewer({
        judge: vi.fn().mockRejectedValue(new Error('judge down')),
      });
      const out = await reviewer(
        input({ candidateAnswer: '建议挂内分泌科', evidenceCount: 2 }),
      );

      expect(out.payload.overall).toBeGreaterThan(0);
      expect(out.degraded?.fallback).toBe('rule-scores');
      expect(out.payload.caveat).toBeTruthy();
    });

    it('judge 返回 null → 同样降级', async () => {
      const reviewer = makeReviewer({ judge: async () => null });
      const out = await reviewer(input({ candidateAnswer: '建议观察', evidenceCount: 1 }));
      expect(out.degraded).toBeDefined();
    });

    it('整个 Agent 崩了 → fallback 仍带免责声明', async () => {
      const reviewer = makeReviewer({
        judge: vi.fn().mockImplementation(() => {
          throw new Error('sync throw');
        }),
      });
      const out = await reviewer(input({ candidateAnswer: 'x' }));
      // 不应抛异常；caveat 必须存在
      expect(out.payload.caveat).toContain('不构成诊断');
    });
  });

  describe('低分回退', () => {
    it('低于阈值 → 发 retry 事件', async () => {
      const reviewer = makeReviewer({
        judge: async () => ({ safety: 1, accuracy: 0.2, completeness: 0.2, groundedness: 0.2 }),
      });
      const out = await reviewer(input({ candidateAnswer: '嗯', evidenceCount: 0 }));

      expect(out.status).toBe('failed');
      expect(out.events.some((e) => e.type === 'retry')).toBe(true);
      const trace = out.events.find((e) => e.type === 'review_trace');
      expect(trace && 'action' in trace ? trace.action : null).toBe('retry');
    });

    it(`连续 ${LOW_SCORE_STREAK_LIMIT} 次低分 → 熔断，停止自动回答`, async () => {
      const reviewer = makeReviewer({
        judge: async () => ({ safety: 1, accuracy: 0.1, completeness: 0.1, groundedness: 0.1 }),
      });
      const out = await reviewer(
        input({
          candidateAnswer: '嗯',
          evidenceCount: 0,
          lowScoreStreak: LOW_SCORE_STREAK_LIMIT - 1,
        }),
      );

      expect(out.status).toBe('blocked');
      expect(out.payload.caveat).toContain('咨询医生');
      // 熔断时不再发 retry，避免无限重试
      expect(out.events.some((e) => e.type === 'retry')).toBe(false);
    });
  });

  it('review_trace 事件总是出现（前端可折叠面板的数据源）', async () => {
    const reviewer = makeReviewer();
    const out = await reviewer(input({ candidateAnswer: '建议挂内科', evidenceCount: 1 }));
    expect(out.events.some((e) => e.type === 'review_trace')).toBe(true);
  });

  it('无证据时免责声明额外说明', async () => {
    const reviewer = makeReviewer();
    const out = await reviewer(input({ candidateAnswer: '建议多喝水', evidenceCount: 0 }));
    expect(out.payload.caveat).toContain('没有引用具体资料');
  });
});

describe('sanitizeAnswer 工具函数', () => {
  it('返回改写后文本', () => {
    const r = sanitizeAnswer('你这是感冒');
    expect(r.answer).not.toContain('你这是感冒');
    expect(r.blocked).toBe(false);
  });

  it('剂量时 blocked=true', () => {
    expect(sanitizeAnswer('每次 10mg 每日两次').blocked).toBe(true);
  });
});

describe('通用免责声明本身', () => {
  it('必须包含"不构成诊断"与"遵医嘱"', () => {
    expect(GENERIC_CAVEAT).toContain('不构成诊断');
    expect(GENERIC_CAVEAT).toContain('遵医嘱');
  });
});
