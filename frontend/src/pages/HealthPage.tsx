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
import {
  dedupeByLatest,
  describeMedication,
  extractMedications,
  isInstructionComplete,
  type MedicationInstruction,
} from '../lib/health/medications';
import { buildPrepList, sortPrepItems, type PrepItem } from '../lib/health/prep';

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

    /*
     * 先登录，再拉数据；任何一步 401 都自动重登一次。
     *
     * 实测场景：后端重启后 JWT 密钥重新生成，页面里的 token 全部作废。
     * 第一版只调 ensureLogin，没有处理"拉数据时才发现失效"的情况 ——
     * 因为 ensureLogin 看到 token 非空就直接返回 ok，
     * 而那个 token 其实已经废了。于是页面显示"读不到你的健康数据"。
     *
     * 修法与预约卡一致：收到 unauthorized 就清 token 重登再试一次。
     * 只重试一次 —— 重登后再失败是别的问题，不该无限循环。
     */
    const fetchAll = async () => {
      const [rec, prof] = await Promise.all([getRecords(), getProfile()]);
      return { rec, prof };
    };

    let { rec, prof } = await fetchAll();

    const unauthorized = (!rec.ok && rec.failure.kind === 'unauthorized') ||
      (!prof.ok && prof.failure.kind === 'unauthorized');

    if (unauthorized) {
      const re = await ensureLogin();
      if (re.ok) {
        ({ rec, prof } = await fetchAll());
      }
    }

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

  /*
   * 用药记录：从所有病历里抽，按药名去重保留最近一次。
   *
   * 为什么按"最近一次"而不是全列出：同一个药在不同医院可能写法与
   * 剂量都变了，全列出会让患者不知道该按哪个吃。保留最新的更接近现状。
   */
  const medications = useMemo(() => {
    const all = state.records.flatMap((r) =>
      extractMedications(r.ocrText ?? '', r.hospitalCode, r.visitDate),
    );
    return dedupeByLatest(all);
  }, [state.records]);

  /** 准备清单按"最可能挂的科"生成：用病历里出现最多的科室 */
  const prepDept = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of state.records) {
      if (!r.department) continue;
      counts.set(r.department, (counts.get(r.department) ?? 0) + 1);
    }
    let best = '全科医学科';
    let max = 0;
    for (const [d, c] of counts) {
      if (c > max) {
        max = c;
        best = d;
      }
    }
    return best;
  }, [state.records]);

  const prepItems = useMemo(
    () =>
      sortPrepItems(
        buildPrepList({
          department: prepDept,
          hasMedications: (state.profile?.medications.length ?? 0) > 0,
          chronics: state.profile?.chronics ?? [],
          records: state.records,
        }),
      ),
    [prepDept, state.profile, state.records],
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

      <MedicationSection items={medications} knownNames={state.profile?.medications ?? []} />

      <PrepSection items={prepItems} department={prepDept} />

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

/* ============================ 用药指导 ============================ */

/**
 * 用药指导卡。
 *
 * <p>只展示病历里**已经写着**的用法，不补全、不推测。
 * 病历里只写了药名的，如实说"没有记录用法"并指向药师 ——
 * 见 lib/health/medications.ts 的边界说明。
 */
function MedicationSection({
  items,
  knownNames,
}: {
  items: MedicationInstruction[];
  knownNames: string[];
}) {
  /*
   * 档案里登记了药名、但病历里查不到用法的，也要列出来 ——
   * 这正是患者最需要去问的情况，藏起来等于假装没有这个缺口。
   */
  const missing = knownNames.filter(
    (n) => !items.some((m) => m.name.includes(n) || n.includes(m.name)),
  );

  if (items.length === 0 && missing.length === 0) {
    return (
      <section>
        <SectionTitle>用药</SectionTitle>
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-400">
          没有在用药物记录。
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionTitle>
        用药
        <span className="ml-2 text-xs font-normal text-gray-400">
          {items.length + missing.length} 种
        </span>
      </SectionTitle>

      <div className="space-y-2">
        {items.map((m) => {
          const complete = isInstructionComplete(m);
          return (
            <div
              key={`${m.name}-${m.visitDate}`}
              className={`rounded-xl border p-3 ${
                complete ? 'border-gray-200 bg-white' : 'border-amber-200 bg-amber-50/50'
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-gray-900">{m.name}</span>
                {complete ? (
                  <span className="ml-auto text-xs text-gray-400">
                    {m.visitDate || ''}
                  </span>
                ) : (
                  <span className="ml-auto rounded bg-amber-600 px-1.5 py-0.5 text-xs text-white">
                    用法未记录
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm leading-relaxed text-gray-700">
                {describeMedication(m)}
              </p>
              {/* 原始片段：患者可以对照药盒确认我们没有读错 */}
              <p className="mt-1 text-xs text-gray-400">病历原文：{m.source}</p>
            </div>
          );
        })}

        {missing.length > 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white p-3">
            <div className="text-sm font-medium text-gray-900">档案里有、病历里查不到用法</div>
            <p className="mt-1 text-sm text-gray-700">{missing.join('、')}</p>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">
              你的档案里登记了这些药，但上传的病历里没有对应的用法记录。
              建议按药盒上的说明服用；有疑问请咨询开药的医生或药师。
            </p>
          </div>
        ) : null}
      </div>

      <p className="mt-2 rounded-lg bg-gray-100 px-3 py-2 text-xs leading-relaxed text-gray-600">
        以上用法来自你上传的病历原文，我们没有补充或推测。
        如果病历里没写、或与药盒不一致，
        <strong>以医生处方和药盒说明为准</strong>，不要自行调整剂量。
      </p>
    </section>
  );
}

/* ============================ 就诊准备 ============================ */

const PREP_META: Record<PrepItem['level'], { label: string; dot: string; box: string }> = {
  must: { label: '必须', dot: 'bg-red-500', box: 'border-gray-200 bg-white' },
  ask: { label: '要问医生', dot: 'bg-amber-500', box: 'border-amber-200 bg-amber-50/50' },
  should: { label: '建议', dot: 'bg-gray-400', box: 'border-gray-200 bg-white' },
};

function PrepSection({ items, department }: { items: PrepItem[]; department: string }) {
  if (items.length === 0) return null;

  return (
    <section>
      <SectionTitle>
        下次就诊前准备
        <span className="ml-2 text-xs font-normal text-gray-400">
          按 {department} 生成
        </span>
      </SectionTitle>

      <div className="space-y-2">
        {items.map((p) => {
          const meta = PREP_META[p.level];
          return (
            <div key={p.title} className={`rounded-xl border p-3 ${meta.box}`}>
              <div className="flex items-start gap-2">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-gray-900">{p.title}</span>
                    <span className="ml-auto shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                      {meta.label}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-gray-700">{p.detail}</p>
                  <p className="mt-1 text-xs leading-relaxed text-gray-400">为什么：{p.why}</p>
                </div>
              </div>
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
