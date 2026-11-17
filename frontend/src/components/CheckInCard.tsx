/* ------------------------------------------------------------------
 * 签到 —— 到院后的第一个动作
 *
 * ============ 它做什么、不做什么 ============
 *
 * 做：在**我们自己的库**里记下"患者说他到医院了"的时间点。
 * 不做：不调用院方系统，不代表院方那边已经报到。
 *
 * 这个区别必须在界面上说清楚，否则患者以为点完就不用去自助机刷，
 * 到了诊室被叫回去重新排队 —— 那比没有这个按钮糟得多。
 *
 * ============ 为什么值得做（而不是让患者自己去机器前排队） ============
 *
 * 自助机前的队是真实存在的：老人不会用、读卡器不认、单子打不出来。
 * 在手机上先点一下，至少能：
 *   · 让患者在等待期间就看到"该去哪、还差多久"
 *   · 万一机器出问题，他心里有个数，不会以为号丢了
 *
 * 所以它的定位是"陪同"而不是"替代"：文案里写清楚真正签到的位置。
 * ------------------------------------------------------------------ */

import { useState } from 'react';
import { checkInBooking, type BookingOrder } from '../lib/api';

type Phase = 'idle' | 'submitting' | 'done' | 'error';

export function CheckInCard({
  order,
  onCheckedIn,
}: {
  order: BookingOrder;
  /** 签到成功后通知父组件刷新 —— 让页面上的其他区块跟着变 */
  onCheckedIn: (updated: BookingOrder) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');

  const alreadyCheckedIn = Boolean(order.checkinAt);
  const cancelled = order.status === 'CANCELLED';
  const completed = order.status === 'COMPLETED';

  const submit = async () => {
    setPhase('submitting');
    const r = await checkInBooking(order.id);

    if (r.ok) {
      setPhase('done');
      onCheckedIn(r.data);
      return;
    }
    setPhase('error');
    setMessage(
      r.failure.kind === 'unreachable'
        ? '签到服务连不上 —— 请直接到自助机或分诊台报到，不要在那里干等。'
        : 'message' in r.failure
          ? r.failure.message
          : '签到失败，请到自助机或分诊台报到。',
    );
  };

  /* 已取消 / 已完成：不显示签到按钮，也不假装能签 */
  if (cancelled) {
    return (
      <section className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="text-sm text-gray-500">这个预约已经取消，不需要签到。</div>
      </section>
    );
  }

  if (alreadyCheckedIn || phase === 'done') {
    return (
      <section className="rounded-xl border border-green-200 bg-green-50 p-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-green-800">已记录到院</span>
          {order.checkinAt ? (
            <span className="text-xs text-green-700">
              {order.checkinAt.slice(11, 16)}
            </span>
          ) : null}
        </div>
        {/*
          这句话是整张卡的重点。签到只是"我们知道你到了"，
          不是"院方知道你到了"。不说清楚，患者会在诊室门口干等。
        */}
        <p className="mt-1.5 text-xs leading-relaxed text-green-800">
          还需要在自助机或科室分诊台正式报到，那一步才算进院方的排队。
          这一条只是让我们知道你已经到了，可以给你更准的等待提示。
        </p>
      </section>
    );
  }

  if (completed) {
    return (
      <section className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="text-sm text-gray-500">这次就诊已完成。</div>
      </section>
    );
  }

  return (
    <section className="rounded-xl border-2 border-brand-500 bg-brand-50 p-4">
      <div className="text-sm font-medium text-brand-800">到了医院，先签个到</div>
      <p className="mt-1 text-xs leading-relaxed text-brand-900/80">
        点一下之后，这页会告诉你现在该去哪、还要等多久。
        <b className="font-medium">正式报到仍要在自助机或分诊台完成</b>
        —— 那一步才算进院方的排队。
      </p>

      {phase === 'error' ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          {message}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={phase === 'submitting'}
        className="mt-3 h-10 rounded-lg bg-brand-700 px-5 text-sm font-medium text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-gray-300"
      >
        {phase === 'submitting' ? '正在记录…' : '我已到院'}
      </button>
    </section>
  );
}
