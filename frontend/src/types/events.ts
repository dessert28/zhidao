/* ------------------------------------------------------------------
 * Agent 事件流契约 —— SSE 的 14 种事件
 * 依据：docs/05-Agent契约表.md §6（12 种 + 审计补充的 retry / speech）
 *
 * 前端按 type 渲染；这一份类型同时是「AI 交互体验」的验收标准。
 * ------------------------------------------------------------------ */

import type {
  BookingPreview,
  Department,
  RedFlag,
  ReviewScores,
  SupervisorDecision,
  TimelineTask,
} from './contract';

/* ============================ 各事件载荷 ============================ */

/** 展示"AI 正在…"并列出计划，必须先于 token 到达 */
export interface PlanEvent {
  type: 'plan';
  decision: SupervisorDecision;
  reason: string;
  agents: string[];
}

/** 流式打字机 */
export interface TokenEvent {
  type: 'token';
  text: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: 'tool_result';
  name: string;
  result: unknown;
  ok: boolean;
}

/** 追问气泡 + 快捷选项 */
export interface ClarifyEvent {
  type: 'clarify';
  question: string;
  missing: string[];
}

export interface DepartmentCardEvent {
  type: 'department_card';
  departments: Department[];
}

/** 预约预览卡：确认/取消按钮绑在这里 */
export interface BookingPreviewCardEvent {
  type: 'booking_preview_card';
  preorder: BookingPreview;
}

export interface TimelineCardEvent {
  type: 'timeline_card';
  tasks: TimelineTask[];
}

/** 可折叠的"质量评估"面板；action 决定是否触发回退 */
export interface ReviewTraceEvent {
  type: 'review_trace';
  scores: ReviewScores;
  action: 'pass' | 'retry';
}

/** Reviewer 低分回退时前端可见形态（审计 3.1 补充） */
export interface RetryEvent {
  type: 'retry';
  reason: string;
  from: string;
  to: string;
  round: number;
}

/** 黄色警示条 */
export interface CaveatEvent {
  type: 'caveat';
  text: string;
}

/** 全屏红色紧急提示；命中即终止本轮 */
export interface EmergencyEvent {
  type: 'emergency';
  redFlag: RedFlag;
}

/** TTS 播报 + 同步字幕（审计 3.2 补充，输出侧模态） */
export interface SpeechEvent {
  type: 'speech';
  text: string;
  lang: string;
  seq: number;
}

export interface DoneEvent {
  type: 'done';
  turnId: string;
  /** 本轮总耗时 ms，用于演示"P50 优化"叙事 */
  elapsedMs: number;
  degraded: boolean;
  /**
   * 本轮结束时的分诊会话状态，**下一轮必须原样带回**。
   *
   * <p>为什么放在 done 里而不是单独一个事件：
   * 前端每轮只看 done 决定"这轮结束了"，顺带收状态最自然；
   * 多一个事件就多一个可能丢的环节。
   *
   * <p>为什么必须带回：没有它，每一轮都是独立会话 ——
   * 用户答过"好几天了"，下一轮系统还会再问一次"多久了"。
   * 这个缺陷实测过，用户感知是"这东西根本记不住话"。
   */
  session?: {
    /** 已采集到的症状槽位 */
    slots: Record<string, string | undefined>;
    /** 已追问的轮数，用于"最多问 3 轮"的熔断 */
    round: number;
  };
}

/* ============================ 判别式联合 ============================ */

export type AgentEvent =
  | PlanEvent
  | TokenEvent
  | ToolCallEvent
  | ToolResultEvent
  | ClarifyEvent
  | DepartmentCardEvent
  | BookingPreviewCardEvent
  | TimelineCardEvent
  | ReviewTraceEvent
  | RetryEvent
  | CaveatEvent
  | EmergencyEvent
  | SpeechEvent
  | DoneEvent;

export type AgentEventType = AgentEvent['type'];

/** SSE 帧 shape：`event: <type>` + `data: <json>` */
export interface SseFrame<T extends AgentEvent = AgentEvent> {
  event: T['type'];
  data: T;
}
