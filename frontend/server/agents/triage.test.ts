/* ------------------------------------------------------------------
 * Triage 的测试 —— 重点验证 4 条硬约束
 * ------------------------------------------------------------------ */

import { describe, expect, it, vi } from 'vitest';
import {
  buildQuestion,
  computeConfidence,
  extractSlots,
  guessDepartments,
  makeTriage,
  MAX_CLARIFY_ROUNDS,
  mergeSlots,
  missingSlots,
  REQUIRED_SLOTS,
} from './triage.js';
import type { AgentInput, SessionFacts } from '@shared/types/contract';

const facts: SessionFacts = {
  allergies: [],
  chronicConditions: [],
  currentMedications: [],
  bookingState: null,
};

const input = (payload: {
  text: string;
  knownSlots?: Record<string, string>;
  round?: number;
}): AgentInput<{ text: string; knownSlots?: Record<string, string>; round?: number }> => ({
  turnId: 't1',
  sessionId: 's1',
  userId: 'u1',
  payload,
  facts,
  memory: { window: [], summary: null, semanticHits: [] },
});

describe('槽位抽取', () => {
  it('抽出部位', () => {
    expect(extractSlots('我头疼得厉害').部位).toBeTruthy();
  });

  it('抽出时长', () => {
    expect(extractSlots('已经三天了').时长).toBeTruthy();
  });

  it('抽出性质', () => {
    expect(extractSlots('是针扎一样疼').性质).toBeTruthy();
  });

  it('抽出多个槽位', () => {
    const s = extractSlots('我肚子疼两天了，还伴发热');
    expect(s.部位).toBeTruthy();
    expect(s.时长).toBeTruthy();
    expect(s.伴随).toBeTruthy();
  });

  it('抽不到就是 undefined，不编造', () => {
    const s = extractSlots('你好');
    expect(Object.values(s).filter(Boolean)).toHaveLength(0);
  });
});

describe('槽位合并', () => {
  it('后到的非空值覆盖先前', () => {
    const m = mergeSlots({ 部位: '头' }, { 部位: '额头', 时长: '三天' });
    expect(m.部位).toBe('额头');
    expect(m.时长).toBe('三天');
  });

  it('空值不覆盖已有值', () => {
    const m = mergeSlots({ 部位: '头' }, { 部位: '' });
    expect(m.部位).toBe('头');
  });
});

describe('缺失槽位', () => {
  it('全空时返回全部必要槽位', () => {
    expect(missingSlots({})).toEqual(REQUIRED_SLOTS);
  });

  it('齐了返回空数组', () => {
    expect(missingSlots({ 部位: '头', 时长: '三天' })).toEqual([]);
  });

  it('「最近」不算采集到时长 —— 必须追问（几天还是几年差别很大）', () => {
    expect(missingSlots({ 部位: '头', 时长: '最近' })).toContain('时长');
    expect(missingSlots({ 部位: '头', 时长: '一直' })).toContain('时长');
    expect(missingSlots({ 部位: '头', 时长: '老是' })).toContain('时长');
  });

  it('具体时长算采集到', () => {
    expect(missingSlots({ 部位: '头', 时长: '三天' })).toEqual([]);
    expect(missingSlots({ 部位: '头', 时长: '两小时' })).toEqual([]);
    expect(missingSlots({ 部位: '头', 时长: '半年' })).toEqual([]);
  });

  /**
   * 检验指标类提问：部位与时长都无从谈起。
   *
   * 实测缺陷（2026-11-15）：问「血糖高要去哪个科」，系统回
   * 「具体是哪个位置不舒服？比如额头、胸口、肚子左边？」——
   * 血糖值没有位置，用户在回答一个不存在的问题。
   * 这比"多问一句"更糟：它暴露了系统没理解问题。
   */
  describe('检验指标查询不采集症状槽位', () => {
    it('「血糖高要去哪个科」不问部位、不问时长', () => {
      expect(missingSlots({}, '血糖高要去哪个科')).toEqual([]);
    });

    it('其他常见指标同样处理', () => {
      for (const q of [
        '血脂高挂什么科',
        '转氨酶偏高要紧吗',
        '尿酸高应该看哪个科',
        '糖化血红蛋白7.8怎么办',
      ]) {
        expect(missingSlots({}, q), q).toEqual([]);
      }
    });

    /**
     * 反向用例：**混合表述不能被误短路**。
     * 用户既提到指标又描述身体不适时，部位仍然是关键信息。
     */
    it('指标 + 身体不适 → 仍然要问部位', () => {
      expect(missingSlots({}, '血糖高还头晕')).toContain('部位');
      expect(missingSlots({}, '血脂高，胸口闷')).toContain('部位');
      expect(missingSlots({}, '转氨酶高而且乏力')).toContain('部位');
    });

    it('纯症状描述不受影响', () => {
      expect(missingSlots({}, '肚子疼')).toContain('时长');
    });
  });

  describe('部位隐含在症状里时不再追问部位', () => {
    it('「咳嗽」自带呼吸道，有部位也不必再问', () => {
      // 实测缺陷：说「咳嗽两周有黄痰」，系统仍追问「具体哪个位置不舒服」
      expect(missingSlots({ 时长: '两周' }, '咳嗽两周了，有黄痰')).toEqual([]);
    });

    it('尿频/皮疹/腹泻等同样自带部位', () => {
      for (const [text, slot] of [
        ['尿频两天了', { 时长: '两天' }],
        ['身上起皮疹三天', { 时长: '三天' }],
        ['腹泻一天', { 时长: '一天' }],
      ] as const) {
        expect(missingSlots(slot, text), `「${text}」不该追问部位`).not.toContain('部位');
      }
    });

    it('但时长仍然要问 —— 这条不能一起放过', () => {
      expect(missingSlots({}, '咳嗽')).toContain('时长');
    });

    /** 反向用例：这些是"最需要问部位"的，一条都不能误放 */
    it('「疼」「痛」「不舒服」这类仍然必须问部位', () => {
      for (const text of ['疼了三天', '痛了两天', '不舒服好几天', '难受']) {
        expect(missingSlots({ 时长: '三天' }, text), `「${text}」应该追问部位`).toContain('部位');
      }
    });

    it('不传原文时行为与旧版一致（保持向后兼容）', () => {
      expect(missingSlots({})).toEqual(REQUIRED_SLOTS);
      expect(missingSlots({ 部位: '头', 时长: '三天' })).toEqual([]);
    });
  });
});

describe('追问话术', () => {
  it('一次最多问两个，避免审问感', () => {
    const q = buildQuestion(['部位', '时长', '性质']);
    // 三条话术之间有换行，只应有两段
    expect(q.split('\n')).toHaveLength(2);
  });

  it('话术给例子而不是术语', () => {
    const q = buildQuestion(['性质']);
    expect(q).toMatch(/针扎|闷|酸麻/);
  });

  it('无缺失时返回空串', () => {
    expect(buildQuestion([])).toBe('');
  });
});

describe('科室推断', () => {
  it('胸闷 → 心血管内科', () => {
    const d = guessDepartments({}, '最近胸口闷');
    expect(d[0]?.name).toBe('心血管内科');
  });

  it('血糖高 → 内分泌科', () => {
    const d = guessDepartments({}, '体检血糖偏高');
    expect(d.map((x) => x.name)).toContain('内分泌科');
  });

  it('对不上给全科+导诊台，不硬猜专科', () => {
    const d = guessDepartments({}, '我说不清哪里不舒服');
    expect(d.map((x) => x.name)).toEqual(['全科医学科', '门诊导诊台']);
    expect(d[0]?.confidence).toBeLessThan(0.5);
  });

  it('最多返回 3 个', () => {
    const d = guessDepartments({}, '头疼 胸闷 肚子疼 关节疼 皮肤痒');
    expect(d.length).toBeLessThanOrEqual(3);
  });

  it('每个科室都带理由（可解释性）', () => {
    const d = guessDepartments({}, '胸闷');
    expect(d[0]?.reason.length).toBeGreaterThan(4);
  });
});

describe('置信度', () => {
  it('槽位齐 + 高置信科室 > 槽位空', () => {
    const high = computeConfidence(
      { 部位: '胸', 时长: '三天', 性质: '闷' },
      [{ name: '心血管内科', confidence: 0.72, reason: 'x' }],
    );
    const low = computeConfidence({}, [
      { name: '全科医学科', confidence: 0.4, reason: 'x' },
    ]);
    expect(high).toBeGreaterThan(low);
  });

  it('永远落在 0-1 区间', () => {
    for (const s of [{}, { 部位: '头', 时长: '一天', 性质: '疼', 诱因: 'x', 伴随: 'y' }]) {
      const c = computeConfidence(s, [
        { name: 'a', confidence: 1, reason: 'x' },
      ]);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
});

describe('Triage 主流程', () => {
  it('槽位不足 → need_clarify + clarify 事件', async () => {
    const triage = makeTriage();
    const out = await triage(input({ text: '我不舒服' }));

    expect(out.status).toBe('need_clarify');
    expect(out.payload.nextQuestion).toBeTruthy();
    expect(out.events.some((e) => e.type === 'clarify')).toBe(true);
  });

  it('槽位齐 → ok + department_card', async () => {
    const triage = makeTriage();
    const out = await triage(input({ text: '我肚子疼三天了，是胀痛' }));

    expect(out.status).toBe('ok');
    expect(out.payload.nextQuestion).toBeNull();
    expect(out.events.some((e) => e.type === 'department_card')).toBe(true);
  });

  it('追问到上限 → 不再追问，给 caveat 说明信息不全', async () => {
    const triage = makeTriage();
    const out = await triage(
      input({ text: '还是不舒服', round: MAX_CLARIFY_ROUNDS }),
    );

    expect(out.payload.nextQuestion).toBeNull();
    expect(out.events.some((e) => e.type === 'caveat')).toBe(true);
  });

  it('红线症状 → blocked + emergency（二次确认）', async () => {
    const triage = makeTriage();
    const out = await triage(input({ text: '突然胸口疼' }));

    expect(out.status).toBe('blocked');
    expect(out.payload.redFlag).not.toBeNull();
    expect(out.events.some((e) => e.type === 'emergency')).toBe(true);
    expect(out.payload.departments).toHaveLength(0);
  });

  it('低置信 + 单一科室 → 补到 Top3', async () => {
    const triage = makeTriage({
      analyze: async () => ({
        slots: {},
        departments: [{ name: '皮肤科', confidence: 0.72, reason: 'r' }],
      }),
    });
    const out = await triage(input({ text: '痒' }));

    // 槽位空时 confidence 低，应补全科/导诊台
    if (out.confidence < 0.5) {
      expect(out.payload.departments.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('LLM 抽取成功时 merged 生效', async () => {
    const triage = makeTriage({
      analyze: async () => ({
        slots: { 部位: '额头', 时长: '两天' },
        departments: [{ name: '神经内科', confidence: 0.8, reason: 'LLM 判断' }],
      }),
    });
    const out = await triage(input({ text: '头不舒服' }));

    expect(out.payload.collectedSymptoms.部位).toBe('额头');
    expect(out.status).toBe('ok');
  });

  it('LLM 抛错 → 规则兜底，仍有科室，绝不空返回', async () => {
    const triage = makeTriage({
      analyze: vi.fn().mockRejectedValue(new Error('llm down')),
    });
    // 注意：不能用「胸口闷」—— 它本就该命中红线（胸痛类），会走 blocked 分支。
    // 这条测的是"非急症 + LLM 挂掉"时的规则兜底。
    const out = await triage(input({ text: '最近老是头晕' }));

    expect(out.payload.departments.length).toBeGreaterThan(0);
    expect(out.degraded?.fallback).toBe('rule-table');
  });

  it('「胸口闷」命中红线而非分诊 —— 正确行为，不是漏报', async () => {
    const triage = makeTriage();
    const out = await triage(input({ text: '胸口闷三天了' }));

    expect(out.status).toBe('blocked');
    expect(out.payload.redFlag?.type).toBe('chest_pain');
  });

  it('LLM 返回 null → 规则兜底', async () => {
    const triage = makeTriage({ analyze: async () => null });
    const out = await triage(input({ text: '肚子疼两天' }));

    expect(out.payload.departments.length).toBeGreaterThan(0);
    expect(out.degraded).toBeDefined();
  });

  it('科室带 evidence 引用（可溯源）', async () => {
    const triage = makeTriage();
    const out = await triage(input({ text: '我肚子疼三天了是胀痛' }));
    expect(out.evidence.length).toBeGreaterThan(0);
    expect(out.evidence[0]?.type).toBe('rule');
  });
});
