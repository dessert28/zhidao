/* ------------------------------------------------------------------
 * PageHeader —— 页面标题
 *
 * 这段 `text-xl font-semibold tracking-tight text-gray-900` 原来复制了 7 份，
 * 副标题的间距和行高还各写一套（mt-1.5 vs mt-2，带不带 leading-relaxed）。
 *
 * <p>首页不用它 —— 首页交给 TodayHero，标题由英雄区承担，
 * 否则一屏里会出现"今天要做什么"两遍。
 * ------------------------------------------------------------------ */

import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** 标题上方的小字（如"我的病历"这类归属说明） */
  eyebrow?: ReactNode;
  /** 右侧操作。手机宽度下会自动折到下一行 */
  action?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, eyebrow, action, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-start gap-x-3 gap-y-2', className)}>
      <div className="min-w-0 flex-1">
        {eyebrow ? (
          <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-gray-500">
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">{title}</h1>
        {subtitle ? (
          <p className="mt-1.5 text-sm leading-relaxed text-gray-500">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
