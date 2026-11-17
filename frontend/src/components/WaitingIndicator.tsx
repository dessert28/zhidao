/* ------------------------------------------------------------------
 * 等待提示 —— 让"慢"变得可以理解
 *
 * ============ 为什么需要它 ============
 *
 * 实测单次 LLM 往返 5–8.5 秒，而一轮对话要串行跑
 * Supervisor → Triage → Reviewer 三个 Agent，正常情况就要 15–25 秒，
 * 模型慢的时候 40 秒以上。
 *
 * 原来这里只有一个静态的"正在思考…"。静止的文字对用户来说
 * 和"卡住了"没有区别 —— 10 秒之后他就会开始怀疑是不是网络断了，
 * 然后刷新页面，把已经跑了一半的对话扔掉。
 *
 * ============ 为什么显示"阶段"而不是百分比 ============
 *
 * 我们不知道模型这次会花多久，编一个进度条（走到 80% 再卡住）
 * 比没有更糟。但**阶段是确定的**：plan 事件说明调度完了，
 * 那之后就是分诊。把真实发生的阶段说出来，用户能判断
 * "它在动，不是死了"。
 *
 * 计时器同理：它只陈述事实（等了多久），不预测剩余时间。
 * ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import type { StreamEvent } from '../hooks/useEventStream';

/** 根据已经收到的事件，推断当前走到哪一步 */
function stageOf(events: readonly StreamEvent[]): string {
  for (const e of events) {
    if (e.type === 'token' || e.type === 'department_card' || e.type === 'clarify') {
      return '正在整理结果…';
    }
    if (e.type === 'review_trace') return '正在自检…';
    if (e.type === 'booking_preview_card' || e.type === 'timeline_card') {
      return '正在查号源…';
    }
  }
  // 收到过 plan 说明调度已完，正在跑子 Agent
  if (events.some((e) => e.type === 'plan')) return '正在分析你的情况…';
  // 还没有任何事件：多半卡在调度这一步（模型慢的时候常见）
  return '正在理解你的问题…';
}

/**
 * 等待超过这个秒数就补一句解释。
 *
 * <p>10 秒是个经验值：低于它的等待，用户通常不会怀疑；
 * 超过之后开始觉得"是不是没反应"。这时给一句"模型响应较慢"
 * 比让他自己猜要好 —— 猜的结果往往是去刷新。
 */
const EXPLAIN_AFTER_SEC = 10;

export function WaitingIndicator({ events }: { events: readonly StreamEvent[] }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const stage = stageOf(events);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs text-gray-400">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
        <span>{stage}</span>
        {elapsed > 0 ? <span className="tabular-nums">（{elapsed} 秒）</span> : null}
      </div>

      {elapsed >= EXPLAIN_AFTER_SEC ? (
        <p className="text-xs leading-relaxed text-gray-400">
          这次比平时慢一些，模型还在处理。不用刷新，回答好了会直接出现。
        </p>
      ) : null}
    </div>
  );
}
