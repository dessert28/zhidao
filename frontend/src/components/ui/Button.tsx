/* ------------------------------------------------------------------
 * Button —— 按钮（以及给 <Link> 用的 buttonClass）
 *
 * ============ 为什么必须同时导出 class 函数 ============
 *
 * 项目里"看起来像按钮"的东西有三种落地方式：<button>、<Link>、
 * 以及 onClick 挂在 div 上。如果只提供组件，<Link> 那批就得继续手抄
 * class，视觉又会慢慢分叉。所以核心是 buttonClass()，组件只是它的壳。
 *
 * ============ 主按钮为什么叫 action 而不是 brand ============
 *
 * brand-700 同时被当"文字色"和"实心按钮底"用。深色模式下这两者要往
 * 相反方向走（文字要变亮、按钮底要保持深才能托住白字），
 * 所以底色的变量单独拆成 action。
 * ------------------------------------------------------------------ */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-action text-white hover:bg-action-hover disabled:bg-gray-300',
  secondary: 'border border-gray-200 bg-surface text-gray-700 hover:border-brand-300 hover:text-brand-700',
  ghost: 'text-gray-500 hover:bg-gray-100 hover:text-gray-800',
  // 危险操作永远不用主色，也别用整块红底 —— 那和急症提示撞在一起
  danger: 'border border-red-200 bg-surface text-red-700 hover:bg-red-50',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-9 px-4 text-sm',
  lg: 'h-11 px-4 text-sm',
};

export interface ButtonClassOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

/** 给 <Link> / <a> 用：它们不能渲染成 <Button>，但要长得一样 */
export function buttonClass({
  variant = 'primary',
  size = 'md',
  className,
}: ButtonClassOptions = {}): string {
  return cn(
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-100',
    VARIANT[variant],
    SIZE[size],
    className,
  );
}

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    Omit<ButtonClassOptions, 'className'> {
  children: ReactNode;
}

export function Button({ variant, size, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClass({ variant, size, className })} {...rest}>
      {children}
    </button>
  );
}
