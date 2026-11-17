/* ------------------------------------------------------------------
 * 首页英雄区
 *
 * ============ 它承担的是"第一句话" ============
 *
 * 打开 App 的第一屏要回答两个问题：这是干什么的、我今天该做什么。
 * 所以这一张卡里塞了三层，从上到下依次降低视觉权重：
 *   1. 身份行 —— 「Hi」+ 日期胶囊。斜体衬线是整页唯一一处非医疗笔触，
 *      它让人先放松下来，再看下面的信息；
 *   2. 一句自述 + 一句今天的具体情况；
 *   3. 六个快捷入口和底部那行进度 / 主行动。
 *
 * ============ "华丽"的边界 ============
 *
 * 华丽不等于满屏渐变。大面积渐变 + 白字是老人最难读的组合：
 * 渐变中段的明度不可控，字压在哪个色阶上全看运气。
 * 所以这里只做三件事：
 *   · 右上角一团很淡的青绿光晕（hero-glow，不铺满整卡）
 *   · 标题区保持纯底色，最高对比度留给最该读的那句话
 *   · 一个能看懂的核心数字（今天几档药、记了几档），而不是五个数字
 *
 * ============ 不编名字 ============
 *
 * PatientProfile 里没有姓名字段。写"张阿姨，下午好"就是假数据 ——
 * 演示时被问一句"这名字哪来的"就没法答。所以问候只有一个「Hi」，
 * 具体是谁由日期和这一页的内容自己说明。
 * ------------------------------------------------------------------ */

import { Link } from 'react-router-dom';
import { buttonClass } from '../ui/Button';
import { ArrowRightIcon } from '../ui/icons';
import { QuickActions } from './QuickActions';

export interface TodayHeroProps {
  now: Date;
  /** 今天有几个服药时间点 */
  slotsTotal: number;
  /** 一共几种药 */
  medCount: number;
  /** 已记录服用 / 已跳过 */
  taken: number;
  skipped: number;
  /** 今日待办条数 */
  todayCount: number;
  /** 今天有没有任何安排 */
  hasAnything: boolean;
  /** 今天是否要去医院（决定主行动文案） */
  hasVisitToday: boolean;
  /** 有没有未来的预约 */
  hasUpcomingBooking: boolean;
}

/** 月份 / 日拆开渲染：月小日大，一眼认出今天几号 */
function dateParts(now: Date): { month: string; day: string } {
  return { month: `${now.getMonth() + 1}月`, day: String(now.getDate()) };
}

export function TodayHero({
  now,
  slotsTotal,
  medCount,
  taken,
  skipped,
  todayCount,
  hasAnything,
  hasVisitToday,
  hasUpcomingBooking,
}: TodayHeroProps) {
  const recorded = taken + skipped;
  const { month, day } = dateParts(now);

  /*
   * 主行动只给一个。
   *
   * 优先级按"此刻最可能想要做的事"排：今天要就诊 → 怎么走；
   * 有未来的预约 → 看一眼预约；有药没记录 → 去问诊；
   * 什么都没有 → 上传病历（这是唯一的起步动作）。
   */
  const primary = hasVisitToday
    ? { to: '/visit', label: '今天怎么走' }
    : hasUpcomingBooking
      ? { to: '/visit', label: '看我的预约' }
      : slotsTotal > 0
        ? { to: '/chat', label: '去问诊' }
        : { to: '/records', label: '上传病历' };

  /*
   * 副标题：有数据就说数据，没数据就说能做什么。
   * 两句话长度不同但语气一样 —— 都是在回答"今天"。
   */
  const facts = [
    slotsTotal > 0 ? `今天 ${slotsTotal} 个服药时间点、${medCount} 种药` : '',
    todayCount > 0 ? `${todayCount} 项待办要确认` : '',
  ].filter(Boolean);

  const subtitle = hasAnything
    ? `${facts.join('，')}。`
    : '把病历交给我，我帮你看懂指标、记住要吃的药，告诉你今天该做什么、到院怎么走。';

  return (
    <section
      className="hero-glow relative animate-fade-up overflow-hidden rounded-3xl border border-brand-200/70 bg-surface p-5 shadow-card"
      aria-label="今天的概况"
    >
      <div className="relative">
        {/* 身份行：Hi + 日期胶囊。日期在右，和"今天"这个主题呼应 */}
        <div className="flex items-start gap-3">
          <span className="font-serif text-[30px] font-bold italic leading-none tracking-tight text-brand-700">
            Hi
          </span>
          <div
            className="ml-auto shrink-0 rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 px-2.5 pb-1 pt-0.5 text-center"
            aria-label={`${month}${day}日`}
          >
            <span className="block text-2xs font-semibold text-brand-700">{month}</span>
            <span className="block text-[17px] font-bold leading-tight tabular-nums text-gray-900">
              {day}
            </span>
          </div>
        </div>

        <h1 className="mt-2.5 text-[22px] font-semibold leading-snug tracking-tight text-gray-900">
          我是你的 AI 导诊助手
        </h1>

        <p className="mt-1.5 text-sm leading-relaxed text-gray-700">{subtitle}</p>

        <QuickActions />

        {/* 卡底：核心数字 + 主行动。两者都在拇指热区 */}
        <div className="mt-4 flex items-center gap-3 border-t border-gray-200/80 pt-3.5">
          {slotsTotal > 0 ? <ProgressRing taken={recorded} total={slotsTotal} /> : null}

          <p className="min-w-0 flex-1 text-xs leading-relaxed text-gray-600">
            {slotsTotal === 0 ? (
              '还没有从病历里读到用药安排'
            ) : recorded === 0 ? (
              <>
                <b className="font-semibold text-gray-900">今天有 {slotsTotal} 个服药时间点</b>
                <br />
                还没有记录
              </>
            ) : recorded >= slotsTotal ? (
              <>
                <b className="font-semibold text-gray-900">今天的药都记完了</b>
                <br />
                共 {slotsTotal} 档
              </>
            ) : (
              <>
                <b className="font-semibold text-gray-900">还有 {slotsTotal - recorded} 档没记录</b>
                <br />
                今天共 {slotsTotal} 档
              </>
            )}
          </p>

          <Link
            to={primary.to}
            className={buttonClass({
              size: 'md',
              className:
                'shrink-0 rounded-full bg-gradient-to-br from-brand-600 to-brand-700 shadow-card hover:brightness-105',
            })}
          >
            {primary.label}
            <ArrowRightIcon size={14} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * 进度环。
 *
 * <p>中心写「1/4」而不是「25%」：老人家对"四档里记了一档"的理解
 * 比百分比具体，而且分数不依赖换算。
 */
function ProgressRing({ taken, total }: { taken: number; total: number }) {
  const r = 19;
  const c = 2 * Math.PI * r;
  const ratio = total > 0 ? Math.min(taken / total, 1) : 0;

  return (
    <div
      className="relative h-[46px] w-[46px] shrink-0"
      role="img"
      aria-label={`今天 ${total} 档药，已记录 ${taken} 档`}
    >
      <svg viewBox="0 0 46 46" className="h-[46px] w-[46px] -rotate-90" aria-hidden="true">
        <circle cx="23" cy="23" r={r} fill="none" strokeWidth="5" className="stroke-gray-100" />
        <circle
          cx="23"
          cy="23"
          r={r}
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - ratio)}
          className="stroke-brand-600 transition-[stroke-dashoffset] duration-500 ease-out-soft"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-bold tabular-nums text-brand-700">
        {taken}/{total}
      </span>
    </div>
  );
}

export default TodayHero;
