/* ------------------------------------------------------------------
 * Supervisor —— 决策与路由
 * 依据：docs/05-Agent契约表.md §1
 *
 * 三条硬约束：
 *   1. 只能调 get_session_state / get_user_profile / resume_pending_task，
 *      **永不碰业务工具**（业务工具归各子 Agent）
 *   2. reason 字段必填 —— 前端要展示"AI 在想什么"
 *   3. 降级阶梯必须实现：超时 → 规则路由；JSON 坏 → 重试一次 → 规则路由
 * ------------------------------------------------------------------ */

import type {
  AgentInput,
  AgentName,
  AgentOutput,
  SupervisorDecision,
  SupervisorPayload,
} from '@shared/types/contract';
import type { AgentEvent } from '@shared/types/events';
import { emptyOutput, safeRun } from './safe-run.js';

/** Supervisor 被允许持有的工具，仅此三个 */
export const SUPERVISOR_TOOLS = [
  'get_session_state',
  'get_user_profile',
  'resume_pending_task',
] as const;

/**
 * Supervisor 的超时预算。
 *
 * ============ 为什么从 8000 调到 30000 ============
 *
 * 这个值原来写的是 8000，看起来"一个调度决策 8 秒够了"。
 * 实测（2026-11-16）发现它根本不够：
 *
 *   · 单次 LLM 往返实测 5.2 – 8.5 秒（同一天连测三次）
 *   · 走到这里之前，`plan()` 内部最坏会调**两次**
 *     （第一次输出坏 JSON → 带提示重试一次）
 *   · 所以最坏情况需要 2 × 8.5 = 17 秒
 *
 * 8 秒的结果是：慢一点就必然超时，用户看到「AI 调度暂不可用」。
 * 而那句提示会让人以为是系统坏了，实际上只是模型今天有点慢。
 *
 * ============ 为什么不干脆调到很大 ============
 *
 * 超时存在的意义是"别让用户无限等"。30 秒是一次 LLM 往返
 * 的 4 倍余量，同时仍然远小于用户愿意等的上限。
 * 再大就该优化调用次数（比如缓存计划），而不是继续放宽。
 *
 * ============ 与 CALL_TIMEOUT_MS 的关系 ============
 *
 * llm/client.ts 的单次调用超时是 12 秒。**上层必须大于下层**，
 * 否则下层还没放弃，上层已经砍断 —— 那个配置就永远没机会生效。
 * 30 > 12，这个关系是刻意的，改动时两边一起看。
 */
export const SUPERVISOR_TIMEOUT_MS = 30_000;

/* ============================ 规则路由 ============================ */

const DEPT_WORDS = /(挂|预约|挂号|号源|排队|改约|取消|约个|约号)/;
const SYMPTOM_WORDS =
  /(疼|痛|酸|麻|胀|痒|晕|吐|拉|咳|喘|烧|发热|不舒服|难受|肿|出血|失眠|便秘)/;
const KNOWLEDGE_WORDS = /(是什么|为什么|怎么办|能不能|要不要|注意什么|吃什么|忌口|准备|科普)/;

/**
 * LLM 不可用时的确定性路由。顺序即优先级 —— 先看用户想"办事"还是"问病"。
 * 这段逻辑是纯函数，可单测，答辩可现场演示"断网也能分诊"。
 */
export function routeByRules(text: string): SupervisorPayload {
  const t = text.trim();

  if (DEPT_WORDS.test(t)) {
    return mk('schedule', ['scheduler'], '识别到挂号/预约意图，交由排程处理');
  }
  if (SYMPTOM_WORDS.test(t)) {
    return mk('triage', ['triage'], '识别到症状描述，交由分诊采集槽位');
  }
  if (KNOWLEDGE_WORDS.test(t)) {
    return mk('retrieve', ['retrieval'], '识别到知识性提问，交由循证检索');
  }
  // 无法判断时走分诊：宁可多问一句，不要答错
  return mk('triage', ['triage'], '未识别明确意图，默认进入分诊采集');
}

function mk(
  decision: SupervisorDecision,
  agents: AgentName[],
  reason: string,
): SupervisorPayload {
  return { decision, agents, reason, requiresClarify: false, missing: [] };
}

/* ============================ 计划校验 ============================ */

const VALID_DECISIONS: SupervisorDecision[] = ['triage', 'retrieve', 'schedule', 'multi', 'done'];
const VALID_AGENTS: AgentName[] = ['supervisor', 'triage', 'retrieval', 'scheduler', 'reviewer'];

/** 校验 LLM 返回的计划是否合法；不合法返回 null（触发重试或规则兜底） */
export function parsePlan(raw: unknown): SupervisorPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.decision !== 'string' || !VALID_DECISIONS.includes(o.decision as SupervisorDecision)) {
    return null;
  }
  if (typeof o.reason !== 'string' || o.reason.trim() === '') return null;

  const agents = Array.isArray(o.agents)
    ? o.agents.filter((a): a is AgentName => VALID_AGENTS.includes(a as AgentName) && a !== 'supervisor')
    : [];

  const decision = o.decision as SupervisorDecision;
  // 除 done 外至少要有一个子 Agent，否则计划无意义
  if (decision !== 'done' && agents.length === 0) return null;

  return {
    decision,
    agents,
    reason: o.reason.slice(0, 200),
    requiresClarify: o.requiresClarify === true,
    missing: Array.isArray(o.missing) ? o.missing.filter((m) => typeof m === 'string') : [],
  };
}

/**
 * 冲突消解：多 Agent 并行但存在依赖时，必须串行。
 * 规则：分诊结果决定检索方向，检索结果决定排程科室 —— 固定 Triage → Retrieval → Scheduler。
 */
export const SERIAL_ORDER: AgentName[] = ['triage', 'retrieval', 'scheduler'];

export function serializeIfConflicting(agents: AgentName[]): AgentName[] {
  if (agents.length <= 1) return agents;
  const ordered = SERIAL_ORDER.filter((a) => agents.includes(a));
  const rest = agents.filter((a) => !SERIAL_ORDER.includes(a));
  return [...ordered, ...rest];
}

/* ============================ multi 计划展开 ============================ */

/** 一次 multi 决策要真正执行哪几条链路 */
export interface MultiPlan {
  /** 跑分诊（含内部串行的 Reviewer 与号源查询） */
  triage: boolean;
  /** 跑循证检索 */
  retrieval: boolean;
  /** 单独跑排程：只有在没有 triage 时才需要，否则 triage 内部已查过号源 */
  scheduleAlone: boolean;
}

/**
 * 把 Supervisor 给出的 agent 列表展开成"要跑哪几条链路"。
 *
 * <p><b>为什么单独抽出来</b>：这段判断决定了并行时跑什么、怎么排序，
 * 逻辑一错就是"要么漏答一半需求，要么重复查两次号源"。
 * 写成纯函数才能把各种组合钉死在测试里 —— 尤其是「只给 reviewer」
 * 「给了 scheduler 但没给 triage」这类模型可能吐出的退化组合。
 *
 * <p><b>返回空计划表示无可用链路</b>：调用方应退回单路分诊
 * （宁可多问一句，不要答错），而不是静默什么都不做。
 *
 * <p>注意 `scheduler` 与 `triage` 同时出现时不再单独跑：
 * triage 分支内部会带着科室去查号源，重复跑会把同一张
 * 预约预览卡下发两次，前端会渲染出两张一模一样的卡。
 */
export function resolveMultiPlan(agents: readonly AgentName[]): MultiPlan {
  const wanted = new Set(
    agents.filter((a): a is AgentName => a === 'triage' || a === 'retrieval' || a === 'scheduler'),
  );

  const triage = wanted.has('triage');
  return {
    triage,
    retrieval: wanted.has('retrieval'),
    scheduleAlone: wanted.has('scheduler') && !triage,
  };
}

/* ============================ 主处理 ============================ */

export interface SupervisorDeps {
  /** 调大模型；返回结构化计划或抛错。测试时可注入假实现 */
  plan: (input: AgentInput<{ text: string }>) => Promise<unknown>;
}

export function makeSupervisor(deps: SupervisorDeps) {
  async function handle(
    input: AgentInput<{ text: string }>,
  ): Promise<AgentOutput<SupervisorPayload>> {
    const ask = deps.plan;

    // 第一次尝试
    let parsed = parsePlan(await ask(input));

    // 坏 JSON：带错误提示重试一次（§1 降级阶梯第 2 级）
    if (!parsed) {
      parsed = parsePlan(await ask({ ...input, payload: { ...input.payload, text: withRetryHint(input.payload.text) } }));
    }

    // 仍是坏的：规则路由（第 1/3 级共用兜底）
    const plan = parsed ?? routeByRules(input.payload.text);
    const events: AgentEvent[] = [
      { type: 'plan', decision: plan.decision, reason: plan.reason, agents: plan.agents },
    ];

    return {
      status: plan.requiresClarify ? 'need_clarify' : 'ok',
      payload: plan,
      confidence: parsed ? 0.85 : 0.6,
      evidence: [],
      events,
      ...(parsed ? {} : { degraded: { stage: 'supervisor', reason: 'llm plan invalid', fallback: 'rule-routing' } }),
    };
  }

  return (input: AgentInput<{ text: string }>) =>
    safeRun(handle, input, {
      agent: 'supervisor',
      timeoutMs: SUPERVISOR_TIMEOUT_MS,
      fallback: {
        ...emptyOutput<SupervisorPayload>(routeByRules(input.payload.text)),
        events: [
          {
            type: 'plan',
            decision: 'triage',
            reason: '调度超时，已切换本地规则路由',
            agents: ['triage'],
          },
        ],
        degraded: { stage: 'supervisor', reason: 'timeout', fallback: 'rule-routing' },
      },
    });
}

function withRetryHint(text: string): string {
  return `${text}\n\n[系统提示] 上一次输出不是合法 JSON，请只返回 JSON 对象，字段为 decision/agents/reason/requiresClarify/missing。`;
}

/* ============================ 代码自检 ============================ */

/**
 * 供 Reviewer 与测试共用：确认 Supervisor 计划没有越界碰业务工具。
 * 返回违规工具名列表，空数组即合规。
 */
export function auditSupervisorTools(used: string[]): string[] {
  return used.filter((t) => !(SUPERVISOR_TOOLS as readonly string[]).includes(t));
}
