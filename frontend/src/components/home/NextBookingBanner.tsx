/* ------------------------------------------------------------------
 * 「下次就诊」横条
 *
 * ============ 它占的是"广告位"，但不是广告 ============
 *
 * 首页第一屏最值钱的位置是顶部那条横条。放一条广告会让人立刻
 * 学会忽略这块区域；放"下次就诊"，它就是每天打开都要扫一眼的东西。
 *
 * ============ 为什么说"还剩 N 天"而不是只给日期 ============
 *
 * 「2026-11-22 14:00」要读者自己做一次减法才知道还有几天，
 * 而患者真正关心的是"还有几天"这个数。日期仍然保留 ——
 * 请假、条码核对、跟家人说时间都要用到绝对日期，两者不能互相替代。
 *
 * ============ 没有预约时整条不渲染 ============
 *
 * 空着比写「暂无预约」安静：后者是一句没有任何信息量的话，
 * 却占掉第一屏最贵的一行。
 * ------------------------------------------------------------------ */

import { Link } from 'react-router-dom';
import { ArrowRightIcon, CalendarCheckIcon } from '../ui/icons';

export interface UpcomingBooking {
  department: string;
  /** 院区名。已由 hospitalName() 翻译成中文，不是编码 */
  hospital: string;
  /** ISO 本地时间，如 2026-11-22T14:00 */
  visitTime: string;
  /** 是不是今天 */
  today: boolean;
  /** 距今天几天（今天为 0） */
  daysUntil: number;
  /** CREATED = 还没确认，需要患者打个电话或到自助机取号 */
  pending: boolean;
}

export function NextBookingBanner({ booking }: { booking: UpcomingBooking }) {
  const [, month, day] = booking.visitTime.slice(0, 10).split('-').map(Number);
  const time = booking.visitTime.slice(11, 16);

  const when = booking.today
    ? `今天 ${time}`
    : booking.daysUntil === 1
      ? `明天 ${time}`
      : `${month} 月 ${day} 日 ${time}`;

  const countdown = booking.today
    ? '就是今天'
    : booking.daysUntil === 1
      ? '明天'
      : `还剩 ${booking.daysUntil} 天`;

  return (
    <Link
      to="/visit"
      className="flex items-center gap-3 rounded-2xl border border-gray-200/80 bg-surface px-3.5 py-3 shadow-card transition-colors hover:border-brand-200"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 text-brand-700">
        <CalendarCheckIcon size={20} />
      </span>

      <span className="min-w-0 flex-1">
        {/*
          两行：第一行是"什么时候去"，第二行是"去哪"。
          原来把科室和院区塞在日期同一行，院区名一长就被截成
          "心血管内科 · 浙江大学…" —— 而院区恰恰是最容易走错的信息，
          宁可让它单独占一行、按长度截断，也不能让它挤在日期后面。
        */}
        <span className="flex items-baseline gap-1.5">
          <span className="text-xs font-medium text-gray-500">下次就诊</span>
          {booking.pending ? (
            <span className="rounded bg-alert-solid px-1 py-px text-3xs font-medium text-white">
              待确认
            </span>
          ) : null}
          <span className="ml-auto shrink-0 text-2xs font-medium tabular-nums text-brand-700">
            {countdown}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-sm font-semibold text-gray-900">
          {when}
          <span className="ml-1.5 font-normal text-gray-500">
            {booking.department} · {booking.hospital}
          </span>
        </span>
      </span>

      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700"
      >
        <ArrowRightIcon size={15} />
      </span>
    </Link>
  );
}

export default NextBookingBanner;
