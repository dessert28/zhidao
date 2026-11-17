/* ------------------------------------------------------------------
 * 院内导航 —— 「在院内」那一段的患者侧界面
 *
 * ============ 它解决什么 ============
 *
 * 到院后的真实困境不是"不知道要做什么"，是**找不到地方**：
 * 抽血在三楼还是四楼、取药前要不要先缴费、
 * 现在这个点该去哪一步。
 *
 * 时间轴卡片说的是"按什么顺序做"（空腹抽血 → 报到 → 见医生），
 * 这个组件补的是"每一步在哪、怎么走、现在去合不合适"。
 *
 * ============ 两个刻意的设计 ============
 *
 * 1. **必须显示"数据来源"**。
 *    目前的楼层是按三甲医院通用布局构造的示意数据。
 *    把示意楼层说成真实导航，比不做导航更糟 —— 患者会照着走错。
 *    所以 dataQuality = SAMPLE 时，界面上有明确标注。
 *
 * 2. **"现在该去哪"要能自动刷新**。
 *    患者不会每隔五分钟手动点一次刷新。组件内部按预约时间
 *    定时重算，并在原地更新高亮的那一步。
 *
 * ============ 为什么不走 SSE ============
 *
 * 导航是纯查询，没有流式内容。用普通 REST + 前端定时轮询更简单，
 * 断网重连也不用额外处理 —— 下一次轮询自然就恢复了。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionTitle } from './ui/SectionTitle';
import { getNavRoute, type NavStep, type NavRoute } from '../lib/api';

export interface NavProps {
  hospitalCode: string;
  department: string;
  /** 预约时间 ISO */
  visitTime: string;
  /** 是否需要空腹（决定抽血排在哪） */
  needsFasting?: boolean;
}

/** 状态 → 视觉与文案。集中在一处，避免每个地方各写一套 */
const STATUS_META: Record<
  NavStep['status'],
  { label: string; dot: string; text: string; ring: string }
> = {
  DONE: {
    label: '已完成',
    dot: 'bg-gray-300',
    text: 'text-gray-400',
    ring: 'border-gray-200 bg-surface',
  },
  /*
   * SKIPPED 与 DONE 视觉上要区分开。
   * 把"医生说这项不用查"显示成"已完成"，患者回看时会以为自己
   * 做过那项检查 —— 这是医疗场景里不能含糊的一处。
   */
  SKIPPED: {
    label: '已跳过',
    dot: 'bg-gray-200',
    text: 'text-gray-400 line-through',
    ring: 'border-gray-100 bg-gray-50',
  },
  CURRENT: {
    label: '现在去这里',
    dot: 'bg-action ring-4 ring-brand-100',
    text: 'text-gray-900',
    ring: 'border-brand-300 bg-brand-50/40 shadow-sm',
  },
  UPCOMING: {
    label: '待办',
    dot: 'bg-gray-300',
    text: 'text-gray-600',
    ring: 'border-gray-200 bg-surface',
  },
};

export function HospitalNav({ hospitalCode, department, visitTime, needsFasting = false }: NavProps) {
  const [route, setRoute] = useState<NavRoute | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    const r = await getNavRoute({ hospitalCode, department, needsFasting, visitTime });
    if (r.ok) {
      setRoute(r.data);
      setError(null);
    } else {
      setError(
        r.failure.kind === 'unreachable'
          ? '院内导航服务未启动'
          : r.failure.kind === 'unauthorized'
            ? '登录已失效'
            : r.failure.message,
      );
    }
    setLoading(false);
  }, [hospitalCode, department, needsFasting, visitTime]);

  useEffect(() => {
    void load();
    /*
     * 每 2 分钟刷新一次状态。
     *
     * 为什么不是更短：状态只在"跨过某一步的建议时间"时才变，
     * 2 分钟内不会有第二次变化；轮询太密只是无谓请求。
     * 也不用 SSE —— 导航没有流式内容，轮询足够且更简单。
     */
    const timer = setInterval(() => void load(), 120_000);
    return () => clearInterval(timer);
  }, [load]);

  const current = useMemo(() => route?.steps.find((s) => s.status === 'CURRENT'), [route]);

  if (loading) {
    return (
      <section>
        <SectionTitle>到院怎么走</SectionTitle>
        <div className="h-24 animate-pulse rounded-xl bg-gray-100" />
      </section>
    );
  }

  if (error || !route || route.steps.length === 0) {
    return (
      <section>
        <SectionTitle>到院怎么走</SectionTitle>
        <div className="rounded-xl border border-gray-200 bg-surface p-4 text-sm text-gray-400">
          {error ?? '这个院区还没有配置院内导航，可以到一楼服务台问路。'}
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionTitle>
        到院怎么走
        <span className="ml-2 text-xs font-normal text-gray-400">
          {route.steps.length} 步 · 约 {route.totalMinutes} 分钟
        </span>
      </SectionTitle>

      {/* 现在该去哪 —— 单独摘出来放大，这是患者最需要的一行 */}
      {current ? (
        <div className="mb-3 rounded-xl border-2 border-brand-500 bg-brand-50 p-4">
          <div className="flex items-center gap-2 text-xs font-medium text-brand-700">
            <span className="flex h-1.5 w-1.5 rounded-full bg-action" />
            现在去这里
          </div>
          <div className="mt-1.5 text-base font-semibold text-gray-900">
            {current.place.building} {current.place.floor} · {current.place.name}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-gray-700">{current.place.directions}</p>
          {current.place.openHours ? (
            <p className="mt-1.5 text-xs text-gray-500">开放时间：{current.place.openHours}</p>
          ) : null}
        </div>
      ) : null}

      {/* 完整路线 */}
      <ol className="space-y-2">
        {route.steps.map((step) => {
          const meta = STATUS_META[step.status];
          const open = expanded === step.order;
          return (
            <li key={step.order}>
              <button
                type="button"
                onClick={() => setExpanded(open ? null : step.order)}
                className={`w-full rounded-xl border p-3 text-left transition-colors ${meta.ring}`}
              >
                <div className="flex items-start gap-2.5">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${meta.dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className={`text-sm font-medium ${meta.text}`}>
                        {step.order}. {step.stageLabel}
                      </span>
                      <span className="text-xs text-gray-400">
                        {step.place.building} {step.place.floor}
                      </span>
                      {step.status === 'CURRENT' ? (
                        <span className="ml-auto rounded bg-action px-1.5 py-0.5 text-xs text-white">
                          现在去
                        </span>
                      ) : step.status === 'DONE' ? (
                        <span className="ml-auto text-xs text-gray-400">已完成</span>
                      ) : null}
                    </div>

                    <div className={`mt-0.5 text-sm ${step.status === 'DONE' ? 'text-gray-400' : 'text-gray-800'}`}>
                      {step.place.name}
                    </div>

                    {/* 折叠时只显示地点，展开才显示走法与注意事项 */}
                    {open ? (
                      <>
                        <p className="mt-1.5 text-xs leading-relaxed text-gray-600">
                          {step.place.directions}
                        </p>
                        {step.place.openHours ? (
                          <p className="mt-1 text-xs text-gray-400">开放时间：{step.place.openHours}</p>
                        ) : null}
                        {step.note ? (
                          <p className="mt-1.5 rounded bg-amber-50 px-2 py-1 text-xs leading-relaxed text-amber-800">
                            {step.note}
                          </p>
                        ) : null}
                        {step.place.estMinutes ? (
                          <p className="mt-1 text-xs text-gray-400">
                            预计耗时约 {step.place.estMinutes} 分钟
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <p className="mt-0.5 truncate text-xs text-gray-400">{step.place.directions}</p>
                    )}
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ol>

      {/*
        数据来源说明必须在。
        示意数据被当成真实导航会让患者走错楼层 —— 这比不给导航更糟。
      */}
      {route.dataQuality !== 'REAL' ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          ⚠️ 以上楼层与窗口位置是<b>演示用示意数据</b>，不是院方提供的实时导航。
          真实导航需院方开放院内地图。到院后仍以现场指示牌与服务台为准。
        </p>
      ) : null}
    </section>
  );
}


export default HospitalNav;
