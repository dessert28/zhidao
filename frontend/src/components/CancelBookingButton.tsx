/* ------------------------------------------------------------------
 * 退号按钮 —— 挂号闭环里最后一块
 *
 * ============ 为什么它需要单独一个组件 ============
 *
 * 退号有两个容易做错的地方：
 *
 * 1. **能不能退要先问后端**。24 小时截止规则、院区差异、
 *    已取消已完成的判断，全在后端的 `CancelPolicy` 里。
 *    前端自己算一遍，规则一改就错。
 *
 * 2. **退号是不可逆的**。退掉的号可能立刻被别人约走，
 *    点错了要不回来。所以必须有二次确认，而且确认里要说清
 *    后果（"这个时段会被释放，可能被别人预约"）。
 *
 * 把它做成独立组件而不是塞进预约列表：列表里每一条的状态
 * 各不相同，混在一起写会出现一堆条件判断。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useState } from 'react';
import { cancelBooking, getCancelPolicy, type CancelPolicy } from '../lib/api';

type State =
  | { phase: 'loading' }
  | { phase: 'idle'; policy: CancelPolicy }
  | { phase: 'confirming'; policy: CancelPolicy }
  | { phase: 'submitting'; policy: CancelPolicy }
  | { phase: 'done' }
  | { phase: 'error'; message: string };

export function CancelBookingButton({
  orderId,
  onCancelled,
}: {
  orderId: number;
  /** 退号成功后通知父组件刷新列表 —— 否则用户会看到一条已经失效的记录 */
  onCancelled: () => void;
}) {
  const [state, setState] = useState<State>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await getCancelPolicy(orderId);
      if (cancelled) return;
      if (!r.ok) {
        /*
         * 政策查不到时**不显示任何按钮**，也不显示"不能退"。
         *
         * 两个选项都错：
         * · 显示按钮 → 点了才失败，用户白跑一趟
         * · 显示"不能退" → 可能是后端挂了，我们给出了错误结论
         * 什么都不显示，用户会去窗口问，那是对的。
         */
        setState({ phase: 'error', message: '暂时查不到退号规则' });
        return;
      }
      setState({ phase: 'idle', policy: r.data });
    })();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const doCancel = useCallback(
    async (policy: CancelPolicy) => {
      setState({ phase: 'submitting', policy });
      const r = await cancelBooking(orderId);

      if (r.ok) {
        setState({ phase: 'done' });
        onCancelled();
        return;
      }
      /*
       * 后端的拒绝原因原样透传。
       * 「距就诊不足 24 小时，请到窗口办理」比「取消失败」有用得多 ——
       * 前者告诉用户接下来干什么。
       */
      setState({
        phase: 'error',
        message:
          r.failure.kind === 'unreachable'
            ? '退号服务连不上，请稍后重试或到窗口办理。'
            : 'message' in r.failure
              ? r.failure.message
              : '退号失败，请到窗口办理。',
      });
    },
    [orderId, onCancelled],
  );

  if (state.phase === 'loading') return null;

  if (state.phase === 'done') {
    return <p className="mt-1 text-xs text-green-700">已退号。这个时段已释放给其他人。</p>;
  }

  if (state.phase === 'error') {
    return <p className="mt-1 text-xs leading-relaxed text-amber-700">{state.message}</p>;
  }

  /* 不能退：只说原因，不给按钮。给一个点了必然失败的按钮是在骗人 */
  if (!state.policy.canCancel) {
    return <p className="mt-1 text-xs leading-relaxed text-gray-400">{state.policy.reason}</p>;
  }

  if (state.phase === 'confirming' || state.phase === 'submitting') {
    const submitting = state.phase === 'submitting';
    return (
      <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5">
        <p className="text-xs leading-relaxed text-amber-900">
          确定退号？退掉之后这个时段会立刻释放，可能被其他人约走，不能再要回来。
        </p>
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void doCancel(state.policy)}
            className="rounded bg-amber-700 px-3 py-1 text-xs font-medium text-white disabled:opacity-60"
          >
            {submitting ? '正在退号…' : '确认退号'}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => setState({ phase: 'idle', policy: state.policy })}
            className="rounded border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 disabled:opacity-60"
          >
            不了
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setState({ phase: 'confirming', policy: state.policy })}
      className="mt-1 text-xs text-gray-500 underline underline-offset-2 hover:text-gray-800"
    >
      退号
      {state.policy.deadline ? (
        <span className="ml-1 text-gray-400">
          （{formatDeadline(state.policy.deadline)} 前可自助退）
        </span>
      ) : null}
    </button>
  );
}

/** 把 ISO 时间压成「11-15 14:00」—— 顶栏空间很窄，不显示秒和年份 */
function formatDeadline(iso: string): string {
  if (!iso) return '';
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}
