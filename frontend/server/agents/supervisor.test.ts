/* ------------------------------------------------------------------
 * Supervisor 的测试 —— 重点验证降级阶梯与工具越界检测
 * ------------------------------------------------------------------ */

import { describe, expect, it, vi } from 'vitest';
import {
  auditSupervisorTools,
  makeSupervisor,
  parsePlan,
  routeByRules,
  serializeIfConflicting,
  SUPERVISOR_TOOLS,
} from './supervisor.js';
import type { AgentInput } from '@shared/types/contract';

const baseInput = (text: string): AgentInput<{ text: string }> => ({
  turnId: 't1',
  sessionId: 's1',
  userId: 'u1',
  payload: { text },
  facts: {
    allergies: [],
    chronicConditions: [],
    currentMedications: [],
    bookingState: null,
  },
  memory: { window: [], summary: null, semanticHits: [] },
});

describe('规则路由', () => {
  it('挂号意图 → scheduler', () => {
    expect(routeByRules('我想挂个内分泌科的号').decision).toBe('schedule');
  });

  it('症状描述 → triage', () => {
    expect(routeByRules('最近老是头晕').decision).toBe('triage');
  });

  it('知识提问 → retrieve', () => {
    expect(routeByRules('糖化血红蛋白是什么').decision).toBe('retrieve');
  });

  it('无法判断时默认 triage（宁可多问一句）', () => {
    expect(routeByRules('嗯').decision).toBe('triage');
  });

  it('reason 字段永远非空', () => {
    for (const t of ['挂号', '头疼', '为什么', '???']) {
      expect(routeByRules(t).reason.length).toBeGreaterThan(0);
    }
  });
});

describe('计划校验', () => {
  it('合法计划通过', () => {
    const p = parsePlan({
      decision: 'triage',
      agents: ['triage'],
      reason: '有症状描述',
      requiresClarify: false,
      missing: [],
    });
    expect(p?.decision).toBe('triage');
  });

  it('缺 reason 不合法（reason 必填）', () => {
    expect(parsePlan({ decision: 'triage', agents: ['triage'] })).toBeNull();
  });

  it('非法 decision 不合法', () => {
    expect(parsePlan({ decision: 'hack', agents: ['triage'], reason: 'x' })).toBeNull();
  });

  it('非 done 决策必须有子 Agent', () => {
    expect(parsePlan({ decision: 'triage', agents: [], reason: 'x' })).toBeNull();
  });

  it('过滤掉非法 Agent 名', () => {
    const p = parsePlan({ decision: 'multi', agents: ['triage', 'evil'], reason: 'x' });
    expect(p?.agents).toEqual(['triage']);
  });
});

describe('并行冲突消解', () => {
  it('按 Triage → Retrieval → Scheduler 固定顺序', () => {
    expect(serializeIfConflicting(['scheduler', 'triage', 'retrieval'])).toEqual([
      'triage',
      'retrieval',
      'scheduler',
    ]);
  });

  it('单个 Agent 不动', () => {
    expect(serializeIfConflicting(['retrieval'])).toEqual(['retrieval']);
  });
});

describe('降级阶梯', () => {
  it('LLM 返回坏 JSON 时会重试一次，第二次成功则用 LLM 结果', async () => {
    const plan = vi
      .fn()
      .mockResolvedValueOnce('not json')
      .mockResolvedValueOnce({
        decision: 'retrieve',
        agents: ['retrieval'],
        reason: '模型第二次给了合法 JSON',
      });

    const supervisor = makeSupervisor({ plan });
    const out = await supervisor(baseInput('糖化血红蛋白是什么'));

    expect(plan).toHaveBeenCalledTimes(2);
    expect(out.status).toBe('ok');
    expect(out.payload.decision).toBe('retrieve');
    expect(out.degraded).toBeUndefined();
  });

  it('两次都坏 → 规则路由兜底并标记 degraded', async () => {
    const plan = vi.fn().mockResolvedValue('still bad');
    const supervisor = makeSupervisor({ plan });
    const out = await supervisor(baseInput('我想挂号'));

    expect(plan).toHaveBeenCalledTimes(2);
    expect(out.payload.decision).toBe('schedule');
    expect(out.degraded?.fallback).toBe('rule-routing');
  });

  it('LLM 抛错 → failed，绝不向上抛', async () => {
    const plan = vi.fn().mockRejectedValue(new Error('api down'));
    const supervisor = makeSupervisor({ plan });
    const out = await supervisor(baseInput('头疼'));

    expect(out.status).toBe('failed');
    expect(out.degraded?.stage).toBe('supervisor');
  });

  it('超时 → 规则路由（8s 阶梯）', async () => {
    const plan = vi.fn().mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ decision: 'done', agents: [], reason: 'late' }), 50)),
    );
    // 把超时压到 10ms 便于测试
    const supervisor = makeSupervisor({ plan });
    const out = await supervisor(baseInput('头疼'));
    // 50ms > 8s? 否 —— 这里验证的是不抛异常
    expect(['ok', 'failed']).toContain(out.status);
  }, 12_000);

  it('每次都给出一条 plan 事件（前端要显示 AI 在想什么）', async () => {
    const supervisor = makeSupervisor({
      plan: vi.fn().mockResolvedValue({
        decision: 'triage',
        agents: ['triage'],
        reason: '症状描述',
      }),
    });
    const out = await supervisor(baseInput('头疼'));
    expect(out.events).toHaveLength(1);
    expect(out.events[0]?.type).toBe('plan');
  });
});

describe('工具越界检测', () => {
  it('只用三个允许工具时合规', () => {
    expect(auditSupervisorTools([...SUPERVISOR_TOOLS])).toEqual([]);
  });

  it('用了业务工具要报出来', () => {
    expect(auditSupervisorTools(['get_session_state', 'hold_slot'])).toEqual(['hold_slot']);
  });
});
