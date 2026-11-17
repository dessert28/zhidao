/* ------------------------------------------------------------------
 * 首页六个快捷入口
 *
 * ============ 为什么是六个，且第一个是实心的 ============
 *
 * 导航收到五项之后，"健康管家/病历/摘要"这些资料型入口需要另一个
 * 落脚点 —— 就是这里。六个是两列的整数倍，也刚好覆盖全站所有高频动作。
 *
 * 只有第一项用实心色标：它代表"今天最该做的那件事"。
 * 六个都上色等于六个都在喊，而首页已经有一个主行动（英雄区右下角），
 * 所以这里只做"轻量提示"，真正的重点留给那颗按钮。
 *
 * ============ 图标为什么手写 ============
 *
 * 见 components/ui/icons.tsx 的注释：全站不到 20 个图形，
 * 为它们引一个图标库等于给首屏多加一个请求。
 * ------------------------------------------------------------------ */

import type { ComponentType } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarCheckIcon,
  ChatIcon,
  HeartIcon,
  PinIcon,
  ReportIcon,
  SheetIcon,
  type IconProps,
} from '../ui/icons';

interface QuickItem {
  to: string;
  label: string;
  Icon: ComponentType<IconProps>;
  /** 实心色标：全组只有一个 */
  primary?: boolean;
}

/*
 * 顺序按"患者今天最可能做的事"排：
 * 拿到化验单先看报告 → 不舒服就问 → 约号 → 到了医院 → 长期管理 → 打印一页纸。
 */
const ITEMS: QuickItem[] = [
  { to: '/records', label: '报告解读', Icon: ReportIcon, primary: true },
  { to: '/chat', label: 'AI 问诊', Icon: ChatIcon },
  { to: '/booking', label: '预约挂号', Icon: CalendarCheckIcon },
  { to: '/visit', label: '到院导航', Icon: PinIcon },
  { to: '/health', label: '健康管家', Icon: HeartIcon },
  { to: '/summary', label: '就诊摘要', Icon: SheetIcon },
];

export function QuickActions() {
  return (
    <div className="relative mt-4 grid grid-cols-2 gap-2.5">
      {ITEMS.map(({ to, label, Icon, primary }) => (
        <Link
          key={to}
          to={to}
          className="flex items-center gap-2 rounded-[15px] border border-gray-200/90 bg-gradient-to-b from-surface to-gray-50/60 px-3 py-2.5 text-sm font-medium text-gray-900 transition-[transform,border-color,box-shadow] duration-150 hover:-translate-y-px hover:border-brand-200 hover:shadow-card"
        >
          <span
            className={
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ' +
              (primary
                ? 'bg-gradient-to-br from-brand-500 to-brand-700 text-white'
                : 'bg-brand-50 text-brand-700')
            }
          >
            <Icon size={15} />
          </span>
          {label}
        </Link>
      ))}
    </div>
  );
}

export default QuickActions;
