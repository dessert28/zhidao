/* ------------------------------------------------------------------
 * 排队估算卡 —— 「我还要等多久」
 *
 * ============ 它解决什么 ============
 *
 * 患者在院外的第二个焦虑点：到得太早白等，到得太晚过号。
 * 这个卡回答两个问题：
 *   "前面还有几个人"（有依据，不是猜）
 *   "现在要不要出发"（可执行的建议）
 *
 * ============ 必须诚实的三件事 ============
 *
 * 1. **这不是院方实时叫号**。真实叫号数据在院方系统里，
 *    我们只有预约人数，所以只能估算。
 *    disclaimer 必须显示 —— 让患者照着估算决定出发时间是会误事的。
 *
 * 2. **算不准时要明说**。就诊不在今天、预约时间已过，
 *    这两种情况 confidence = LOW，界面直接显示"无法估算"，
 *    而不是给一个看起来精确的假数字。
 *
 * 3. **给出数字的来由**。显示"该科室平均每人 60 分钟"，
 *    否则患者看到"还要等 120 分钟"会觉得莫名其妙。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useState } from 'react';
import { getQueueEstimate, type QueueInfo } from '../lib/api';

export interface QueueEstimateCardProps {
  orderId: number;
}

/** 可信度 → 视觉。LOW 用琥珀色提醒，其余用中性色，避免到处是警示 */
const CONFIDENCE_META: Record<string, { label: string; tone: string }> = {
  HIGH: { label: '估算较可靠', tone: 'text-gray-500' },
  MEDIUM: { label: '估算参考值', tone: 'text-gray-500' },
  LOW: { label: '无法估算', tone: 'text-amber-700' },
};

export function QueueEstimateCard({ orderId }: QueueEstimateCardProps) {
  const [info, setInfo] = useState<QueueInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await getQueueEstimate(orderId);
    if (r.ok) {
      setInfo(r.data);
      setError(null);
    } else {
      setError(
        r.failure.kind === 'unreachable'
          ? '排队服务未启动'
          : r.failure.kind === 'unauthorized'
            ? '登录已失效'
            : r.failure.message,
      );
    }
    setLoading(false);
  }, [orderId]);

  useEffect(() => {
    void load();
    /*
     * 每 3 分钟刷新。
     *
     * 为什么比导航（2 分钟）更慢：排队的"前面还有几人"只在
     * 有人下单/取消时变，频率远低于"当前该去哪个步骤"。
     * 更密只是无谓请求。
     */
    const timer = setInterval(() => void load(), 180_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading) {
    return <div className="h-20 animate-pulse rounded-xl bg-gray-100" />;
  }

  if (error || !info) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-3 text-xs text-gray-400">
        {error ?? '暂时查不到排队情况'}
      </div>
    );
  }

  const e = info.estimate;
  const meta = CONFIDENCE_META[e.confidence] ?? CONFIDENCE_META.MEDIUM!;
  const unreliable = e.confidence === 'LOW' || !e.reasonable;

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
        <span className="text-xs font-medium text-gray-700">排队情况</span>
        <span className={`text-xs ${meta.tone}`}>· {meta.label}</span>
      </div>

      <div className="px-3 py-2.5">
        {unreliable ? (
          /* 不可靠时不给大数字 —— 一个精确的假数字比不给数字更危险 */
          <p className="text-sm leading-relaxed text-amber-800">{e.reason}</p>
        ) : (
          <>
            <div className="flex items-baseline gap-4">
              <div>
                <span className="text-xl font-semibold tabular-nums text-gray-900">
                  {e.aheadCount}
                </span>
                <span className="ml-1 text-xs text-gray-500">人在前面</span>
              </div>
              <div>
                <span className="text-xl font-semibold tabular-nums text-gray-900">
                  {e.waitMinutes}
                </span>
                <span className="ml-1 text-xs text-gray-500">分钟</span>
              </div>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-gray-500">
              {e.reason}
              <span className="text-gray-400">
                （该科室平均每人 {info.minutesPerPatient} 分钟）
              </span>
            </p>
          </>
        )}

        {/* 建议单独强调：这是患者真正要的行动 */}
        <p className="mt-2 rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs leading-relaxed text-brand-800">
          {e.advice}
        </p>

        {/* 免责说明常驻，不可关闭 —— 见文件头第 1 点 */}
        <p className="mt-1.5 text-xs leading-relaxed text-gray-400">{e.disclaimer}</p>
      </div>
    </div>
  );
}

export default QueueEstimateCard;
