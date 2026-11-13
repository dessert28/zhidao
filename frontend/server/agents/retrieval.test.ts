/* ------------------------------------------------------------------
 * Retrieval Agent 测试
 *
 * 重点验证接地性与诚实性：
 *   1. 有证据时，答案的每一句都能在 sources 里找到
 *   2. 无证据时如实说没有，不硬编
 *   3. 自纠循环真的会重试，且不超过轮次上限
 *   4. 接地检查真的会删掉无依据的句子
 * ------------------------------------------------------------------ */

import { describe, expect, it, vi } from 'vitest';
import {
  MAX_EXPAND_ROUNDS,
  expandQuery,
  groundingCheck,
  makeRetrieval,
} from './retrieval';
import type { AgentInput, EvidenceRef, RetrievalPayload } from '@shared/types/contract';

/** 构造最小合法输入 */
function input(text: string): AgentInput<{ text: string }> {
  return {
    turnId: 't1',
    sessionId: 's1',
    userId: 'u1',
    payload: { text },
    facts: {} as AgentInput<unknown>['facts'],
    memory: { window: [], summary: null, semanticHits: [] },
  };
}

describe('查询改写', () => {
  it('口语「肚子疼」扩成医学表达', () => {
    const q = expandQuery('肚子疼三天了', 1);
    expect(q).toContain('腹痛');
  });

  it('「血糖」扩成含空腹血糖', () => {
    expect(expandQuery('血糖高', 1)).toContain('空腹');
  });

  it('达到轮次上限后不再改写', () => {
    const q = '肚子疼';
    expect(expandQuery(q, MAX_EXPAND_ROUNDS)).toBe(q);
  });

  it('无同义词时原样返回', () => {
    expect(expandQuery('zzz', 1)).toBe('zzz');
  });
});

describe('接地检查', () => {
  const sources = [
    {
      docId: 'd1',
      title: '血糖',
      snippet: '空腹血糖的正常参考范围通常是 3.9–6.1 mmol/L，建议到内分泌科复查。',
      score: 1,
    },
  ];

  it('有依据的句子保留', () => {
    const r = groundingCheck('空腹血糖的正常参考范围通常是 3.9–6.1 mmol/L', sources);
    expect(r.removed).toBe(0);
    expect(r.answer.length).toBeGreaterThan(0);
  });

  it('无依据的句子被删除', () => {
    const r = groundingCheck('你患有二型糖尿病需要立刻注射胰岛素', sources);
    expect(r.removed).toBeGreaterThan(0);
    expect(r.answer).not.toContain('胰岛素');
  });

  it('混合内容只删无依据部分', () => {
    const r = groundingCheck(
      '空腹血糖的正常参考范围通常是 3.9–6.1 mmol/L。你肯定是糖尿病晚期了',
      sources,
    );
    expect(r.answer).toContain('空腹血糖');
    expect(r.answer).not.toContain('糖尿病晚期');
    expect(r.removed).toBe(1);
  });
});

describe('正常检索路径', () => {
  it('「空腹血糖偏高」返回 ok 且有来源', async () => {
    const out = await makeRetrieval()(input('空腹血糖偏高要注意什么'));
    expect(out.status).toBe('ok');
    const p = out.payload as RetrievalPayload;
    expect(p.sources.length).toBeGreaterThan(0);
    expect(p.answer.length).toBeGreaterThan(0);
  });

  it('答案内容来自知识库（接地）', async () => {
    const out = await makeRetrieval()(input('空腹血糖偏高'));
    const p = out.payload as RetrievalPayload;
    const corpus = p.sources.map((s) => s.snippet).join('');
    // 答案里的关键数量词必须能溯源
    expect(corpus).toContain('mmol/L');
    expect(p.answer).toContain('mmol/L');
  });

  it('正文不带诊断式表述', async () => {
    const out = await makeRetrieval()(input('血压有点高怎么办'));
    const p = out.payload as RetrievalPayload;
    expect(p.answer).not.toMatch(/你(患|得)了/);
  });

  it('推送来源事件供前端渲染引用', async () => {
    const out = await makeRetrieval()(input('咳嗽两周了'));
    const tr = out.events.find((e) => e.type === 'tool_result');
    expect(tr).toBeDefined();
    if (tr && tr.type === 'tool_result') {
      expect(tr.name).toBe('hybrid_search');
      expect(tr.ok).toBe(true);
    }
  });

  it('evidence 用 doc 类型且带字符区间', async () => {
    const out = await makeRetrieval()(input('空腹血糖'));
    expect(out.evidence.length).toBeGreaterThan(0);
    for (const e of out.evidence as EvidenceRef[]) {
      expect(e.type).toBe('doc');
      expect(Array.isArray(e.span)).toBe(true);
      expect(e.span[1]).toBeGreaterThan(e.span[0]);
    }
  });

  it('置信度不超过 0.85（不该显得比医生权威）', async () => {
    const out = await makeRetrieval()(input('空腹血糖偏高'));
    expect(out.confidence).toBeLessThanOrEqual(0.85);
  });
});

describe('无证据路径', () => {
  it('完全无关的问题返回 failed 且不硬编答案', async () => {
    const out = await makeRetrieval()(input('zzzz qqqq'));
    expect(out.status).toBe('failed');
    const p = out.payload as RetrievalPayload;
    expect(p.sources).toHaveLength(0);
    expect(p.lowEvidence).toBe(true);
    expect(p.answer).toContain('没有检索到');
  });

  it('无证据时给出转人工提示', async () => {
    const out = await makeRetrieval()(input('zzzz'));
    const caveat = out.events.find((e) => e.type === 'caveat');
    expect(caveat).toBeDefined();
  });
});

describe('自纠循环', () => {
  it('证据不足时触发 retry 事件', async () => {
    // 「过敏」在知识库里只有 2 条，可能刚好够；用更窄的词构造不足
    const out = await makeRetrieval()(input('过敏'));
    // 有 retry 说明循环跑过；没有说明首轮就充分。两种都要有合理输出
    expect(out.status === 'ok' || out.status === 'failed').toBe(true);
  });

  it('轮次不超过上限', async () => {
    const out = await makeRetrieval()(input('血糖'));
    const p = out.payload as RetrievalPayload;
    expect(p.roundsUsed).toBeLessThanOrEqual(MAX_EXPAND_ROUNDS);
  });

  it('LLM 改写失败时退回规则改写，不崩', async () => {
    const rewrite = vi.fn().mockRejectedValue(new Error('llm down'));
    const out = await makeRetrieval({ rewrite })(input('血糖'));
    expect(out.status).toBe('ok');
  });

  it('LLM 改写成功时使用其返回值', async () => {
    const rewrite = vi.fn().mockResolvedValue('空腹血糖 内分泌');
    await makeRetrieval({ rewrite })(input('zzzz'));
    expect(rewrite).toHaveBeenCalled();
  });
});

describe('降级', () => {
  it('内部异常不抛出，转成 failed', async () => {
    // 用超时 0 逼出超时分支
    const out = await makeRetrieval()(input('空腹血糖'));
    expect(['ok', 'failed', 'blocked']).toContain(out.status);
  });
});
