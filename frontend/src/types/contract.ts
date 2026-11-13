/* ------------------------------------------------------------------
 * Agent 契约 —— 前后端共享的唯一真源
 * 依据：docs/05-Agent契约表.md §0.3 / §6，docs/10-技术决策-补充.md D1
 *
 * 硬约束（改动前先读 docs/05）：
 *   1. status 四态是硬约束，失败必须走 failed/blocked，不允许异常穿透
 *   2. 每个 Agent 的输入输出都套同一信封
 *   3. 事件流 14 种，type 是判别式联合的 discriminant
 * ------------------------------------------------------------------ */

/* ============================ 基础类型 ============================ */

import type { AgentEvent } from './events';

export type AgentStatus = 'ok' | 'need_clarify' | 'blocked' | 'failed';

/** 溯源引用：AI 的每句话都要能回到这里 */
export type EvidenceRef =
  | { type: 'doc'; id: string; span: [number, number] }
  | { type: 'order'; id: string; span: [number, number] }
  | { type: 'record'; id: string; span: [number, number] }
  | { type: 'rule'; id: string; span: [number, number] };

/** 降级说明：哪个环节退到了什么程度 */
export interface DegradeInfo {
  stage: string;
  reason: string;
  fallback: string;
}

/* ============================ 会话事实 ============================ */

/**
 * SessionFacts —— 决定分诊与排程的硬事实，不是"可有可无的背景"
 * 来源：patient_profile.allergy_json / chronic_json + booking_order 当前状态
 */
export interface SessionFacts {
  allergies: string[];
  chronicConditions: string[];
  currentMedications: string[];
  /** 当前挂起的预约状态，Scheduler 用它判断能否重复下单 */
  bookingState: {
    preorderId: string | null;
    hospitalCode: string | null;
    department: string | null;
    status: string | null;
  } | null;
}

/* ============================ 三层记忆 ============================ */

/**
 * MemorySnapshot —— 三层记忆（docs/09 数据模型 §4.4）
 *   滑窗层：chat_turn 最近 6 轮
 *   摘要层：chat_turn.memory_summary（每满 10 轮压缩）
 *   语义层：pgvector 跨会话召回
 */
export interface MemorySnapshot {
  window: Turn[];
  summary: string | null;
  semanticHits: Array<{ text: string; score: number; sessionId: string }>;
}

export interface Turn {
  role: 'user' | 'assistant';
  /** 已脱敏文本。原始文本永远留在 IndexedDB */
  text: string;
  ts: number;
}

/* ============================ 输入 / 输出信封 ============================ */

export interface AgentInput<P = unknown> {
  turnId: string;
  sessionId: string;
  /** 脱敏后的用户 id */
  userId: string;
  payload: P;
  facts: SessionFacts;
  memory: MemorySnapshot;
}

export interface AgentOutput<P = unknown> {
  status: AgentStatus;
  payload: P;
  /** 0-1 */
  confidence: number;
  evidence: EvidenceRef[];
  events: AgentEvent[];
  /** 若降级过，说明原因 */
  degraded?: DegradeInfo;
}

/* ============================ 各 Agent 载荷 ============================ */

/* ---- Supervisor ---- */

export type SupervisorDecision = 'triage' | 'retrieve' | 'schedule' | 'multi' | 'done';
export type AgentName = 'supervisor' | 'triage' | 'retrieval' | 'scheduler' | 'reviewer';

export interface SupervisorPayload {
  decision: SupervisorDecision;
  agents: AgentName[];
  /** 必填：给前端展示"AI 在想什么" */
  reason: string;
  requiresClarify: boolean;
  missing: string[];
}

/* ---- Triage ---- */

export interface Department {
  name: string;
  confidence: number;
  reason: string;
}

/** 红线症状：非 null 直接短路，不经 LLM */
export interface RedFlag {
  type: 'chest_pain' | 'stroke' | 'dyspnea' | 'consciousness' | 'hemorrhage';
  guidance: string;
}

export interface SymptomSlots {
  部位?: string;
  时长?: string;
  诱因?: string;
  性质?: string;
  伴随?: string;
  [key: string]: string | undefined;
}

export interface TriagePayload {
  /** 1-3 个，每个带理由 */
  departments: Department[];
  redFlag: RedFlag | null;
  collectedSymptoms: SymptomSlots;
  /** 非 null 表示还需追问（status 应为 need_clarify） */
  nextQuestion: string | null;
}

/* ---- Retrieval ---- */

export interface Source {
  docId: string;
  title: string;
  snippet: string;
  score: number;
}

export interface RetrievalPayload {
  answer: string;
  sources: Source[];
  roundsUsed: number;
  refinedQueries: string[];
  /** 达到轮次上限仍不充分时置 true */
  lowEvidence: boolean;
}

/* ---- Scheduler ---- */

export interface TimelineTask {
  order: number;
  task: string;
  dependsOn: string[];
  note: string;
}

export interface BookingPreview {
  preorderId: string;
  hospital: string;
  department: string;
  doctor: string | null;
  slot: string;
  /** 锁号 TTL，前端倒计时依据 */
  holdExpiresAt: string;
}

export interface SchedulerPayload {
  action: 'preview_booking' | 'query' | 'timeline' | 'cancel';
  preview: BookingPreview | null;
  timeline: TimelineTask[];
}

/* ---- Reviewer ---- */

export interface ReviewScores {
  safety: number;
  accuracy: number;
  completeness: number;
  groundedness: number;
}

export interface ReviewIssue {
  type: 'ungrounded' | 'unsafe' | 'incomplete' | 'inaccurate';
  detail: string;
  action: 'removed' | 'rewritten' | 'flagged' | 'blocked';
}

export interface ReviewerPayload {
  scores: ReviewScores;
  overall: number;
  issues: ReviewIssue[];
  caveat: string | null;
}
