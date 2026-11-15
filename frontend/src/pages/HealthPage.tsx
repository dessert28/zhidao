/* ------------------------------------------------------------------
 * 健康管家 —— 不是"看一次报告"，是"一直管着你"
 *
 * ============ 与「报告解读」的区别 ============
 *
 * 报告解读是单向的：你上传，我解释，结束。
 * 健康管家是持续的：它记得你的指标、看得到趋势、会主动提醒该做什么。
 *
 * 三块内容：
 *   ① 我的指标趋势 —— 哪些在变好、哪些在变差
 *   ② 该做的检查   —— 按病种提醒，带依据
 *   ③ 一句话总结   —— 现在最该关心哪件事
 *
 * ============ 边界：不诊断 ============
 *
 * 每一处解释都说"参考范围"而不是"正常值"，都说"建议找医生"
 * 而不是"你应该怎么治"。因为：
 *   · 参考范围因实验室、性别、年龄而异
 *   · 我们看不到患者本人，也看不到完整病史
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ensureLogin,
  getProfile,
  getRecords,
  type BackendFailure,
  type MedicalRecord,
  type PatientProfile,
} from '../lib/api';
import { buildTrends, type MarkerTrend } from '../lib/health/markers';
import {
  buildCheckupSuggestions,
  summarizeCheckups,
  type CheckupSuggestion,
} from '../lib/health/checkups';

interface State {
  loading: boolean;
  failure: BackendFailure | null;
  records: MedicalRecord[];
  profile: PatientProfile | null;
}

const EMPTY: State = { loading: true, failure: null, records: [], profile: null };

export default function HealthPage() {
  const [state, setState] = useState<State>(EMPTY);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, failure: null }));

    const auth = await ensureLogin();
    if (!auth.ok) {
      setState({ ...EMPTY, loading: false, failure: auth.failure });
      return;
    }

    const [rec, prof] = await Promise.all([getRecords(), getProfile()]);
    const failure = !rec.ok ? rec.failure : !prof.ok ? prof.failure : null;
    if (failure) {
      setState({ ...EMPTY, loading: false, failure });
      return;
    }

    setState({
      loading: false,
      failure: null,
      records: rec.ok ? rec.data.records : [],
      profile: prof.ok ? prof.data : null,
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const trends = useMemo(() => buildTrends(state.records), [state.records]);
  const checkups = useMemo(
    () =>
      buildCheckupSuggestions(state.profile?.chronics ?? [], state.records),
    [state.profile, state.records],
  );

  if (state.loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
    );
  }

  if (state.failure) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="text-sm font-medium text-amber-900">读不到你的健康数据</div>
        <p className="mt-1 text-xs leading-relaxed text-amber-800">
          {state.failure.kind === 'unreachable'
            ? '后端未启动。在 backend 目录执行 mvn spring-boot:run 后再试。'
            : 'kind' in state.failure && 'message' in state.failure
              ? state.failure.message
              : '请稍后重试。'}
        </p>
        <button
          type="button"
          onClick={load}
          className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs text-amber-800 hover:bg-amber-100"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">健康管家</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">
          根据你上传的病历，帮你看懂指标、记住该做的检查。我们不做诊断，只在需要时提醒你找医生。
        </p>
      </div>

      <SummaryStrip trends={trends} checkups={checkups} chronicCount={state.profile?.chronics.length ?? 0} />

      <CheckupSection items={checkups} hasChronic={(state.profile?.chronics.length ?? 0) > 0} />

      <TrendSection trends={trends} recordCount={state.records.length} />

      <div className="rounded-xl bg-gray-100 p-4">
        <p className="text-xs leading-relaxed text-gray-600">
          <strong className="font-medium text-gray-800">这些判断的依据：</strong>
          参考范围取自成人通用标准，但不同医院的化验单参考范围可能略有差异，
          <strong>请以你化验单上标注的参考范围为准</strong>。
          孕期、儿童、老年人的标准不同，我们不适用。所有建议仅供参考，具体请遵医嘱。
        </p>
      </div>

      <div className="flex gap-2">
        <Link
          to="/records"
          className="inline-flex h-10 items-center rounded-lg border border-gray-200 bg-white px-4 text-sm text-gray-700 hover:border-brand-300"
        >
          我的病历
        </Link>
        <Link
          to="/"
          className="inline-flex h-10 items-center rounded-lg border border-gray-200 bg-white px-4 text-sm text-gray-700 hover:border-brand-300"
        >
          去问诊
        </Link>
      </div>
    </div>
  );
}

/* ============================ 顶部摘要 ============================ */

function SummaryStrip({
  trends,
  checkups,
  chronicCount,
}: {
  trends: MarkerTrend[];
  checkups: CheckupSuggestion[];
  chronicCount: number;
}) {
  const abnormal = trends.filter((t) => {
    const last = t.points[t.points.length - 1];
    return last && last.level !== 'normal';
  });
  const due = checkups.filter((c) => c.status === 'DUE');

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <div className="rounded-xl border border-gray-200 bg-white p-3">
        <div className="text-xs text-gray-400">已跟踪指标</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">
          {trends.length}
        </div>
        <div className="mt-0.5 text-xs text-gray-500">
          {abnormal.length > 0 ? `其中 ${abnormal.length} 项最近一次超出参考范围` : '最近一次都在参考范围内'}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-3">
        <div className="text-xs text-gray-400">该做的检查</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{due.length}</div>
        <div className="mt-0.5 text-xs text-gray-500">
          {chronicCount === 0 ? '档案里还没有慢病记录' : summarizeCheckups(checkups)}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-3">
        <div className="text-xs text-gray-400">建档慢病</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{chronicCount}</div>
        <div className="mt-0.5 text-xs text-gray-500">
          {chronicCount > 0 ? '建议按病种定期复查' : '补全档案后提醒更准'}
        </div>
      </div>
    </div>
  );
}

/* ============================ 该做的检查 ============================ */

const STATUS_META: Record<
  CheckupSuggestion['status'],
  { label: string; box: string; badge: string }
> = {
  DUE: {
    label: '该做了',
    box: 'border-amber-300 bg-amber-50/60',
    badge: 'bg-amber-600 text-white',
  },
  UNKNOWN: {
    label: '记录缺失',
    box: 'border-gray-200 bg-white',
    badge: 'bg-gray-200 text-gray-600',
  },
  NOT_YET: {
    label: '有效期内',
    box: 'border-gray-200 bg-white',
    badge: 'bg-green-100 text-green-700',
  },
};

function CheckupSection({
  items,
  hasChronic,
}: {
  items: CheckupSuggestion[];
  hasChronic: boolean;
}) {
  if (!hasChronic) {
    return (
      <section>
        <SectionTitle>该做的检查</SectionTitle>
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-400">
          档案里还没有慢病记录，暂时无法给出按病种的检查建议。
        </div>
      </section>
    );
  }

  if (items.length === 0) return null;

  return (
    <section>
      <SectionTitle>
        该做的检查
        <span className="ml-2 text-xs font-normal text-gray-400">{items.length} 项</span>
      </SectionTitle>

      <div className="space-y-2">
        {items.map((c) => {
          const meta = STATUS_META[c.status];
          return (
            <div key={c.name} className={`rounded-xl border p-3 ${meta.box}`}>
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-gray-900">{c.name}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs ${meta.badge}`}>
                  {meta.label}
                </span>
                {c.status === 'DUE' && c.monthsSince !== null ? (
                  <span className="ml-auto text-xs text-amber-700">
                    已 {c.monthsSince} 个月未做
                  </span>
                ) : c.lastDone ? (
                  <span className="ml-auto text-xs text-gray-400">上次 {c.lastDone}</span>
                ) : null}
              </div>

              <p className="mt-1.5 text-xs leading-relaxed text-gray-600">{c.reason}</p>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                <span>建议每 {c.intervalMonths} 个月一次</span>
                <span>·</span>
                <span>{c.where}</span>
              </div>

              <p className="mt-1 text-xs text-gray-400">依据：{c.basis}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ============================ 指标趋势 ============================ */

function TrendSection({ trends, recordCount }: { trends: MarkerTrend[]; recordCount: number }) {
  if (trends.length === 0) {
    return (
      <section>
        <SectionTitle>我的指标</SectionTitle>
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-400">
          {recordCount === 0
            ? '还没有病历。上传一份化验单，我就能帮你把指标整理出来。'
            : '已上传的病历里没有识别到常见指标（血糖、血脂、血压等）。'}
          <Link to="/records" className="ml-1 text-brand-700 underline">
            去上传
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionTitle>
        我的指标
        <span className="ml-2 text-xs font-normal text-gray-400">
          {trends.length} 项 · 来自 {recordCount} 份病历
        </span>
      </SectionTitle>

      <div className="space-y-2">
        {trends.map((t) => (
          <TrendCard key={t.name} trend={t} />
        ))}
      </div>
    </section>
  );
}

function TrendCard({ trend }: { trend: MarkerTrend }) {
  const last = trend.points[trend.points.length - 1]!;
  const abnormal = last.level !== 'normal';

  return (
    <div
      className={`rounded-xl border p-3 ${
        abnormal ? 'border-amber-300 bg-amber-50/60' : 'border-gray-200 bg-white'
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-gray-900">{trend.name}</span>
        <span
          className={`text-lg font-semibold tabular-nums ${
            abnormal ? 'text-amber-800' : 'text-gray-800'
          }`}
        >
          {trend.latest}
        </span>
        <span className="text-xs text-gray-500">{trend.unit}</span>
        {abnormal ? (
          <span className="ml-auto rounded bg-amber-600 px-1.5 py-0.5 text-xs text-white">
            {last.level === 'high' ? '偏高' : '偏低'}
          </span>
        ) : (
          <span className="ml-auto rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700">
            参考范围内
          </span>
        )}
      </div>

      <p className="mt-1 text-xs leading-relaxed text-gray-600">{trend.trendText}</p>

      {/* 少量数据点时画出简单的走势：三个以上的点才有意义 */}
      {trend.points.length >= 2 ? (
        <div className="mt-2 flex items-end gap-1.5">
          {trend.points.map((p) => {
            const max = Math.max(...trend.points.map((x) => x.value));
            const min = Math.min(...trend.points.map((x) => x.value));
            const span = max - min || 1;
            const h = 8 + ((p.value - min) / span) * 24;
            return (
              <div key={p.date} className="flex flex-col items-center gap-0.5">
                <div
                  className={`w-2 rounded-sm ${
                    p.level === 'normal' ? 'bg-gray-300' : 'bg-amber-500'
                  }`}
                  style={{ height: `${h}px` }}
                  title={`${p.date}: ${p.value}`}
                />
                <span className="text-[10px] text-gray-400">{p.date.slice(5, 7)}月</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 text-sm font-medium text-gray-700">{children}</h2>;
}
