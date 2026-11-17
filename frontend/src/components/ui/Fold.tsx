/* ------------------------------------------------------------------
 * 折叠 —— 「结论留在外面，证据收在里面」
 *
 * ============ 为什么需要它 ============
 *
 * 病历、健康管家、摘要三页加起来有十几块内容、四五十行小字。
 * 患者是站在医院走廊里划手机的，屏幕上同时有七八条信息，
 * 等于一条都没看见。
 *
 * 但折叠在医疗场景里是有风险的：把「过敏」「用法未记录」
 * 「已经三个月没做检查」折进去，就是拿安全性换整洁。
 *
 * 所以这里的规则很硬：
 *
 *   1. **结论永远露着** —— 药名、剂量、正常/偏高、几天没做
 *   2. **证据默认收起** —— 病历原文、指南依据、"为什么"、
 *      报告的随访提示。这些东西的作用是"可核对"，不是"必读"
 *   3. **折叠标签必须说清里面是什么** —— 不写"更多"，写"查看原文 320 字"
 *
 * `Fold` 折一小段说明，`Clamp` 折一长串列表。
 * 两个都用原生 <details>/<button>，没有额外状态，也不进 JS 包。
 *
 * ============ 打印 ============
 *
 * details 收起时打印会把内容丢掉。摘要页在 beforeprint 里
 * 统一把所有 details 打开（见 SummaryPage），CSS 里也兜了一层。
 * ------------------------------------------------------------------ */

import { useState, type ReactNode } from 'react';
import { ChevronRightIcon } from './icons';

export interface FoldProps {
  /** 折叠标签。要写清里面是什么：「病历原文」「依据」「为什么」 */
  label: ReactNode;
  /** 标签右侧的灰色补充，如「320 字」「4 条」。折叠时也要能判断值不值得点 */
  hint?: ReactNode;
  children: ReactNode;
  /** 默认展开。只给「首次进来必须看见」的内容用 */
  defaultOpen?: boolean;
  /** 外部强制展开（打印前用）。一旦为真，用户再折叠也无效 */
  forceOpen?: boolean;
  className?: string;
}

/**
 * 一小段可折叠的说明。
 *
 * <p>用 <details> 而不是自管 state：浏览器的展开状态可以被
 * 查找（Ctrl+F 命中会自动展开），这对"我到底有没有说过这句话"
 * 这种查证场景很重要。
 */
export function Fold({
  label,
  hint,
  children,
  defaultOpen,
  forceOpen,
  className = '',
}: FoldProps) {
  return (
    /*
     * `|| undefined` 不能省：写成 open={false} 会让 React 每次渲染都把
     * 这个 details 强制关上 —— 用户点了展开，下一次父组件重渲染又缩回去。
     * undefined 等于"不托管"，交还给浏览器。
     */
    <details open={forceOpen || defaultOpen || undefined} className={`group ${className}`}>
      <summary
        className={
          'inline-flex cursor-pointer select-none list-none items-center gap-1 rounded ' +
          'py-0.5 pr-1 text-xs leading-relaxed text-gray-500 transition-colors ' +
          'hover:text-gray-800 [&::-webkit-details-marker]:hidden ' +
          // 强制展开时不让点：点了也还是开着，只会让人以为按钮坏了
          (forceOpen ? 'pointer-events-none' : '')
        }
      >
        <ChevronRightIcon
          size={11}
          className="shrink-0 text-gray-400 transition-transform duration-150 group-open:rotate-90"
        />
        <span>{label}</span>
        {hint ? <span className="text-gray-400">· {hint}</span> : null}
      </summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

export interface ClampProps<T> {
  items: T[];
  /** 收起时显示前几条。别给 0 —— 一条都不给等于把这块藏起来 */
  initial: number;
  itemKey: (item: T) => string | number;
  render: (item: T) => ReactNode;
  /** 展开后追加的尾巴，如「以上为全部记录」 */
  tail?: ReactNode;
  /** 每条之间的间距类，默认 space-y-2 */
  gap?: string;
  /** 量词，默认「条」 */
  unit?: string;
  /** 外部强制展开（打印前用） */
  forceOpen?: boolean;
}

/**
 * 一长串列表的「先看几条，剩下的点开」。
 *
 * <p>为什么不用「滚动容器」：手机上的内嵌滚动区是可见性最差的控件，
 * 用户根本不知道自己只看到了一半。按钮至少承认了"还有"。
 *
 * <p>阈值给到 3–6 条，是因为再长的一屏在手机上也会让人放弃 ——
 * 但收起时必须显示**条数**，让患者知道没被隐藏。
 */
export function Clamp<T>({
  items,
  initial,
  itemKey,
  render,
  tail,
  gap = 'space-y-2',
  unit = '条',
  forceOpen = false,
}: ClampProps<T>) {
  const [open, setOpen] = useState(false);

  const rest = items.length - initial;
  // forceOpen 优先：打印时不管用户先前折没折，一律全出
  const shown = open || forceOpen || rest <= 0 ? items : items.slice(0, initial);

  return (
    <>
      <div className={gap}>
        {shown.map((it) => (
          <div key={itemKey(it)}>{render(it)}</div>
        ))}
      </div>

      {rest > 0 ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={
            'no-print mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg border ' +
            'border-dashed border-gray-300 bg-surface/60 py-2 text-xs text-gray-600 ' +
            'transition-colors hover:border-brand-300 hover:text-brand-700'
          }
        >
          {open ? '收起' : `还有 ${rest} ${unit}，展开`}
          <ChevronRightIcon
            size={11}
            className={'text-gray-400 transition-transform duration-150 ' + (open ? '-rotate-90' : 'rotate-90')}
          />
        </button>
      ) : null}

      {open && tail ? <div className="mt-1.5">{tail}</div> : null}
    </>
  );
}
