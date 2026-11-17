/* ------------------------------------------------------------------
 * Stat —— 统计小卡（标签 + 一个大数字 + 一行说明）
 *
 * 健康管家顶部那三格原来是三段几乎一样的 JSX（只差标签与数字）。
 * 首页英雄区也要用同一种"数字"排版，所以抽出来共用 ——
 * 两处数字的字重、对齐、等宽都要一致，否则一屏里会出现两种"阿拉伯数字"。
 * ------------------------------------------------------------------ */

import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { TONE_TEXT, type Tone } from './tokens';

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  /** 数字的颜色。默认中性 —— 只有"异常"才该让数字变色 */
  tone?: Tone;
  className?: string;
}

const TONE_NUM: Partial<Record<Tone, string>> = {
  alert: 'text-alert',
  clinical: 'text-clinical',
  critical: 'text-critical',
  done: 'text-done',
  brand: 'text-brand-700',
};

export function Stat({ label, value, hint, tone = 'neutral', className }: StatProps) {
  return (
    <div className={cn('rounded-xl border border-gray-200 bg-surface p-3', className)}>
      <div className="text-xs text-gray-500">{label}</div>
      <div
        className={cn(
          'mt-1 text-2xl font-semibold tabular-nums',
          TONE_NUM[tone] ?? TONE_TEXT.neutral,
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-xs leading-relaxed text-gray-500">{hint}</div> : null}
    </div>
  );
}
