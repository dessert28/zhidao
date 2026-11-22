/* ------------------------------------------------------------------
 * 工作台公共样式 —— 只放样式，不放布局
 *
 * ============ 这个文件曾经是两端共用的外壳 ============
 *
 * 原版用 `tabs` 参数把管理端和医生端塞进同一副骨架。看着省事，实际
 * 造出两个问题：
 *   1. 医生端只有一项功能，却被迫挂一条只有一项的侧栏；
 *   2. 品牌区写死 `to="/" state={{ stay: true }}` —— 在医生端
 *      点"医生工作台"那几个字，却被送到患者端首页。这就是那次
 *      "点了首页又回患者端"的根因。
 *
 * 现在两个 Shell 各自写自己的布局骨架。这里只留表单样式与字段
 * 组合：它们本来就该整站一致，且五个后台页通过 AdminShell 的别名
 * 引用，保留这些导出可以让那些页面一行都不用改。
 *
 * 布局代码的重复是有意的 —— 两端可以各自演化，不用再为"共用"
 * 迁就对方的导航结构。
 * ------------------------------------------------------------------ */

import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/* ---------------- 后台表单的公共样式 ----------------
 *
 * 后台是表格 + 表单密集的地方，同一套 input 会在多个页面里出现十几次。
 * 放在这里而不是各页复制：描边色、圆角、聚焦环一旦分叉，
 * 各页的"可输入"感就不一致了。高度用 h-9 而不是更矮 ——
 * 手机上 32px 以下的点击区很容易点空。
 */
export const workspaceFieldClass =
  'h-9 w-full rounded-lg border border-gray-200 bg-surface px-2.5 text-sm text-gray-900 ' +
  'outline-none transition-colors placeholder:text-gray-400 ' +
  'focus:border-brand-400 focus:ring-2 focus:ring-brand-100';

export const workspaceTextareaClass =
  'w-full rounded-lg border border-gray-200 bg-surface px-2.5 py-2 text-sm leading-relaxed ' +
  'text-gray-900 outline-none transition-colors placeholder:text-gray-400 ' +
  'focus:border-brand-400 focus:ring-2 focus:ring-brand-100';

export interface WorkspaceFieldProps {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}

/** 标签 + 控件的竖向组合 */
export function WorkspaceField({ label, hint, className, children }: WorkspaceFieldProps) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-1 text-xs font-medium text-gray-500">{label}</div>
      {children}
      {hint ? <div className="mt-1 text-2xs leading-relaxed text-gray-400">{hint}</div> : null}
    </div>
  );
}
