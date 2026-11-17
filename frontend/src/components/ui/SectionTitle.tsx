/* ------------------------------------------------------------------
 * SectionTitle —— 区块标题
 *
 * 改版前这段 class 在 8 个文件里各写了一份（`mb-2 text-sm font-medium
 * text-gray-700`），连 TodayPage 里的私有函数都叫同一个名字。
 * 小节标题是页面节奏的主要来源，只有一处定义才能整站一起调。
 *
 * ============ 为什么现在带颜色和色条 ============
 *
 * 原来是 14px 灰字，和正文只差一个 font-medium —— 患者扫视时看不出
 * 「这一块讲什么」，整页像一段连续的文字。现在：
 *   · 16px（rem 单位，跟着适老字号一起放大）+ semibold
 *   · 品牌青绿，和全站的 appt/alert/clinical 语义色区分开：
 *     标题只表示"这是一节的开始"，不表示紧急程度
 *   · 左边一条 3px 色条，替代"整行加粗/加底色"这种更吵的做法
 *
 * 对比度：brand-700 在浅色底 5.3:1、深色底（反色后的浅青）更高，
 * 两种主题都过 AA。
 * ------------------------------------------------------------------ */

import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface SectionTitleProps {
  children: ReactNode;
  /** 右侧的计数（"3 项"、"4 个时间点"），用等宽数字对齐 */
  count?: ReactNode;
  /** 右侧操作（如"全部展开"） */
  action?: ReactNode;
  as?: 'h2' | 'h3';
  className?: string;
  /**
   * 是否用"品牌色大字 + 左侧色条"的强调样式，默认开。
   * 只有嵌在小卡片内部的次级小标题才需要关掉。
   */
  emphasis?: boolean;
}

export function SectionTitle({
  children,
  count,
  action,
  as: Tag = 'h2',
  className,
  emphasis = true,
}: SectionTitleProps) {
  return (
    <div className={cn('mb-2 flex items-baseline gap-2', className)}>
      {emphasis ? (
        <span
          aria-hidden="true"
          className="h-3.5 w-[3px] shrink-0 self-center rounded-full bg-brand-500"
        />
      ) : null}
      <Tag
        className={cn(
          'tracking-tight',
          emphasis ? 'text-base font-semibold text-brand-700' : 'text-sm font-medium text-gray-700',
        )}
      >
        {children}
      </Tag>
      {count != null ? (
        <span className="text-xs font-normal tabular-nums text-gray-500">{count}</span>
      ) : null}
      {action ? <div className="ml-auto shrink-0">{action}</div> : null}
    </div>
  );
}
