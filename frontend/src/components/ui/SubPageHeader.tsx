/* ------------------------------------------------------------------
 * SubPageHeader —— 资料区的统一页头（返回 + 标题 + 兄弟页切换）
 *
 * ============ 为什么需要它 ============
 *
 * 病历 / 健康管家 / 就诊摘要 收进「我的」之后暴露了一个真问题：
 * 点进去就出不来了。顶栏的「我的」虽然一直是选中的，但那看起来
 * 只是"当前在哪"，没人会想到它同时是返回键 —— 尤其在长页面里
 * 已经滚到中间的时候。
 *
 * 所以这里给一条明确的返回路径（← 我的），并且把三个兄弟页做成
 * 一条切换条：它们本来就是同一件事的三个切面，看完指标想翻病历，
 * 不该先回到「我的」再点一次。
 *
 * ============ 切换条为什么吸顶 ============
 *
 * 病历页滚到时间轴还剩半屏，此时最常做的两个动作是"切去看指标"
 * 和"回到我的"。这两个动作都在这条带上，所以它得跟着走。
 * `top-14` 正好让开高度 56px 的顶栏，滚动时不会叠在一起。
 * ------------------------------------------------------------------ */

import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ChevronLeftIcon,
  HeartIcon,
  RecordsIcon,
  SheetIcon,
  type IconProps,
} from './icons';
import type { ComponentType } from 'react';

interface Tab {
  to: string;
  label: string;
  Icon: ComponentType<IconProps>;
}

/*
 * 三个兄弟页。顺序 = 从"原始记录"到"加工后的结论"再到"带出去的东西"，
 * 和患者脑子里那件事的推进方向一致。
 */
const TABS: Tab[] = [
  { to: '/records', label: '病历', Icon: RecordsIcon },
  { to: '/health', label: '健康管家', Icon: HeartIcon },
  { to: '/summary', label: '摘要', Icon: SheetIcon },
];

export interface SubPageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 右侧操作（打印、复制这类） */
  action?: ReactNode;
}

export function SubPageHeader({ title, subtitle, action }: SubPageHeaderProps) {
  const { pathname } = useLocation();

  return (
    <div className="mb-4">
      {/* 返回。写「我的」而不是「返回」：让人知道会回到哪，比一个箭头可靠 */}
      <Link
        to="/mine"
        className="-ml-1 inline-flex items-center gap-0.5 rounded-lg py-1 pr-2 text-xs font-medium text-gray-500 transition-colors hover:text-brand-700"
      >
        <ChevronLeftIcon size={15} />
        我的
      </Link>

      <div className="mt-1">
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">{title}</h1>
        {subtitle ? (
          <p className="mt-1.5 text-sm leading-relaxed text-gray-500">{subtitle}</p>
        ) : null}
        {/*
          操作放整行，不跟标题挤在一行。
          「打印 / 存为 PDF」加「复制文字」差不多 230px，并排时会把副标题
          压成一行四个字的窄柱（500px 屏上实测）。操作本来也是第二顺位的事，
          另起一行反而更好点。
        */}
        {action ? <div className="mt-2.5 flex flex-wrap gap-2">{action}</div> : null}
      </div>

      {/*
        切换条吸顶，并且横跨内容区的整宽（-mx-4 抵消 main 的 px-4）。
        渐隐背景 + 毛玻璃：滚动时下面的文字不会从缝里透出来。
      */}
      <nav
        aria-label="健康档案分页"
        className="sticky top-14 z-10 -mx-4 mt-3 border-b border-gray-100 bg-gray-50/90 px-4 py-2 backdrop-blur-md"
      >
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-gray-100/80 p-1">
          {TABS.map(({ to, label, Icon }) => {
            const active = pathname === to || pathname.startsWith(`${to}/`);
            return (
              <Link
                key={to}
                to={to}
                aria-current={active ? 'page' : undefined}
                className={
                  'flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-sm transition-colors ' +
                  (active
                    ? 'bg-surface font-semibold text-brand-700 shadow-card'
                    : 'text-gray-500 hover:text-gray-900')
                }
              >
                <Icon size={15} />
                <span className="whitespace-nowrap">{label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export default SubPageHeader;
