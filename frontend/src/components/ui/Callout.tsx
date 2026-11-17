/* ------------------------------------------------------------------
 * Callout —— 提示块（要求确认的动作、免责、异常）
 *
 * ============ 它存在的理由：把"未知"和"危险"分开 ============
 *
 * 改版前所有提示都是琥珀色：后端没启动、免责声明、化验值超标、
 * 药没写用法 —— 全是黄的。患者学到的结论是"黄色可以忽略"，
 * 于是真正需要行动的那条（空腹禁食）也被一起忽略。
 *
 * 现在：
 *   info      中性灰虚线 —— "这块我们还不知道"（缺数据、免责、服务不可达）
 *   attention 琥珀 —— "现在需要你做点什么"
 *   clinical  紫   —— "这个数值不在正常范围"
 *   critical  红   —— "立刻停下，去急诊"
 * ------------------------------------------------------------------ */

import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { TONE_TEXT, type Tone } from './tokens';

export type CalloutTone = Extract<Tone, 'neutral' | 'alert' | 'clinical' | 'critical'>;

const SHELL: Record<CalloutTone, string> = {
  // 虚线边是"未知"的视觉语汇：内容不假，但我们没确认过
  neutral: 'border-dashed border-gray-300 bg-gray-50 text-gray-700',
  alert: 'border-alert-line bg-alert-soft text-alert',
  clinical: 'border-clinical-line bg-clinical-soft text-clinical',
  critical: 'border-critical-line bg-critical-soft text-critical',
};

export interface CalloutProps {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  /** 右侧动作（重试、知道了） */
  action?: ReactNode;
  /** 正文用更小的字号（默认按正文 14px） */
  dense?: boolean;
  className?: string;
}

export function Callout({
  tone = 'neutral',
  title,
  children,
  action,
  dense = false,
  className,
}: CalloutProps) {
  return (
    <div className={cn('rounded-xl border px-3.5 py-3', SHELL[tone], className)}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {title ? (
            <div className={cn('text-sm font-medium', TONE_TEXT[tone === 'neutral' ? 'muted' : tone])}>
              {title}
            </div>
          ) : null}
          {children ? (
            <div
              className={cn(
                'leading-relaxed',
                title ? 'mt-1' : '',
                dense ? 'text-xs' : 'text-sm',
              )}
            >
              {children}
            </div>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}
