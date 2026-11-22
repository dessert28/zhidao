/* ------------------------------------------------------------------
 * 院内公告条 —— 首页最顶部的一小块「院方要说的话」
 *
 * ============ 为什么失败必须静默降级 ============
 *
 * 公告是首页的附加信息，不是首页的功能本身。后端没起来、公告接口超时、
 * 甚至还没发布过任何公告 —— 这三种情况下患者要做的事完全一样：
 * 看今天的药、看下次就诊。
 *
 * 如果这里失败就和「今日清单」一样弹一块错误提示，首页第一屏就会被
 * 一条"公告读不到"占住，而它恰恰是最不重要的一块。所以失败 = 不渲染，
 * 连重试按钮都不给：没人会为了看公告去点重试。
 *
 * ============ 排序交给后端 ============
 *
 * 置顶在前、同级按发布时间倒序，这条规则是运营语义（谁说了算），
 * 不是展示语义。前端再排一次，两边规则一旦不一致，就会出现
 * 「后台看到的顺序和患者看到的不一样」这种查不出来的问题。
 * ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import { getNotices, type Notice } from '../../lib/api';
import { cn } from '../../lib/utils';
import { ChevronRightIcon } from '../ui/icons';
import { SectionTitle } from '../ui/SectionTitle';

/**
 * 级别 → 徽章。
 *
 * <p>INFO 蓝、WARN 琥珀沿用全站语义色；URGENT 用实心红 ——
 * 一条真正紧急的院内通知（停诊、系统故障）值得比另外两档更响，
 * 而一屏里最多三条，不会把红色用滥。
 */
const INFO_BADGE = { label: '通知', cls: 'bg-appt-soft text-appt' };

const LEVEL: Record<string, { label: string; cls: string }> = {
  INFO: INFO_BADGE,
  WARN: { label: '提醒', cls: 'bg-alert-soft text-alert' },
  URGENT: { label: '紧急', cls: 'bg-critical-solid text-white' },
};

export function NoticeBar() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    void getNotices(3).then((r) => {
      if (cancelled) return;
      // 失败什么都不做：见文件顶部「为什么失败必须静默降级」
      if (!r.ok) return;
      setNotices(r.data);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // 没有公告就整块不渲染 —— 空着比写「暂无公告」安静，后者只占一行注意力
  if (notices.length === 0) return null;

  return (
    <section aria-label="院内公告">
      <SectionTitle count={`${notices.length} 条`}>院内公告</SectionTitle>

      <ul className="overflow-hidden rounded-2xl border border-gray-200/80 bg-surface shadow-card">
        {notices.map((n) => {
          const open = openId === n.id;
          // 后端将来新增级别时按「通知」显示，不把这条公告吞掉
          const badge = LEVEL[n.level] ?? INFO_BADGE;

          return (
            <li key={n.id} className="border-b border-gray-100 last:border-b-0">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : n.id)}
                aria-expanded={open}
                className="flex w-full items-start gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-gray-50/70"
              >
                <span
                  className={cn(
                    'mt-px shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium',
                    badge.cls,
                  )}
                >
                  {badge.label}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block text-sm leading-snug text-gray-900">{n.title}</span>
                  {open ? (
                    <span className="mt-1 block whitespace-pre-line text-2xs leading-relaxed text-gray-600">
                      {n.content}
                    </span>
                  ) : null}
                </span>

                <span
                  className={cn(
                    'mt-0.5 shrink-0 text-gray-300 transition-transform duration-150',
                    open && 'rotate-90',
                  )}
                >
                  <ChevronRightIcon size={13} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default NoticeBar;
