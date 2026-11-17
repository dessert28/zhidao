/* ------------------------------------------------------------------
 * Card —— 全站唯一的卡片容器
 *
 * ============ 它替换掉的是一段复制了 25 次的字符串 ============
 *
 * `rounded-xl border border-gray-200 bg-surface p-4`（及其 p-3 变体）
 * 在 14 个文件里各写了一遍。这次要统一圆角、描边与重点色，
 * 如果不先收敛到一处，任何一次视觉调整都要核对 25 个地方。
 *
 * ============ accent 是"重点"的正确做法 ============
 *
 * 让一条事项跳出来，直觉是给它整块上色；但整块浅黄铺满一列之后，
 * 每一块都在喊，等于都没喊，老人也更容易把彩色块当成"按钮"去点。
 * 所以重点 = 浅底 + 3px 左侧强调条 + 标题用语义色，面积很小但指向明确。
 * ------------------------------------------------------------------ */

import type { ElementType, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { TONE_BAR, TONE_STRONG, TONE_SURFACE, type Tone } from './tokens';

const PAD = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
} as const;

export interface CardProps {
  tone?: Tone;
  pad?: keyof typeof PAD;
  /** 左侧 3px 强调条 —— 用于"今天必须处理"的事项 */
  accent?: boolean;
  /** 2px 实线强调（全站只该用在"现在去这里"这类唯一重点上） */
  strong?: boolean;
  as?: Extract<ElementType, 'div' | 'section' | 'li' | 'article'>;
  className?: string;
  children: ReactNode;
}

export function Card({
  tone = 'neutral',
  pad = 'md',
  accent = false,
  strong = false,
  as: Tag = 'div',
  className,
  children,
}: CardProps) {
  return (
    <Tag
      className={cn(
        // 圆角从 xl 提到 2xl：卡片是这一版页面的主要节奏单位，
        // 16px 圆角在密集列表里会显得毛躁，20px 才和英雄区（24px）一个语气
        'rounded-2xl border shadow-card',
        strong ? TONE_STRONG[tone] : TONE_SURFACE[tone],
        // border-l-* 必须在 accent 打开时才加，否则普通卡片会多一条深色左边线
        accent && ['border-l-[3px]', TONE_BAR[tone]],
        PAD[pad],
        className,
      )}
    >
      {children}
    </Tag>
  );
}
