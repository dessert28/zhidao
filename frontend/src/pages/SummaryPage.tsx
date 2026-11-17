/* ------------------------------------------------------------------
 * 就诊摘要 —— 给医生看的一页纸
 *
 * ============ 为什么要有这一页 ============
 *
 * 患者换一家医院，医生问「以前做过什么检查、在吃什么药」，
 * 患者只能凭记忆答，或者翻一沓皱掉的单据。开出来的重复检查、
 * 重复用药，很多时候不是医生不谨慎，而是**信息根本不在场**。
 *
 * 这一页把散在几家医院的信息压成一页：在吃什么药、对什么过敏、
 * 关键指标怎么变的、在哪些医院看过什么病。
 *
 * ============ 它是本项目最直接的「差异化证明」 ============
 *
 * 区域级平台的数据在平台侧，患者带不走；这一页的存在本身，
 * 就是「数据属于患者」这句话的物理形态 —— 打印出来、递过去，
 * 在任何一家医院都成立，不依赖任何系统互通。
 *
 * ============ 排版原则 ============
 *
 * 1. **一页装得下**：医生只有几十秒，翻页就等于不看
 * 2. **医生最关心的排在最前**：过敏 → 在用药 → 慢病 → 指标 → 就诊史
 * 3. **打印优先**：屏幕上的按钮、导航都不进打印结果
 * 4. **不写诊断结论**：只陈述「哪家医院、什么科室、医生写的诊断原文」
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ensureLogin,
  getProfile,
  getRecords,
  hospitalName,
  loadHospitalCatalog,
  type BackendFailure,
  type MedicalRecord,
  type PatientProfile,
} from '../lib/api';
import { buildTrends } from '../lib/health/markers';
import { dedupeByLatest, extractMedications } from '../lib/health/medications';
import { buildCheckupSuggestions } from '../lib/health/checkups';
import { buildSummaryText, genderLabel } from '../lib/health/summary-text';
import { SubPageHeader } from '../components/ui/SubPageHeader';
import { Clamp } from '../components/ui/Fold';

interface State {
  loading: boolean;
  failure: BackendFailure | null;
  records: MedicalRecord[];
  profile: PatientProfile | null;
}

const EMPTY: State = { loading: true, failure: null, records: [], profile: null };

export default function SummaryPage() {
  const [state, setState] = useState<State>(EMPTY);
  const [copied, setCopied] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  /*
   * 屏幕上"就诊记录"只露最近 6 条，但**打印必须全出**。
   *
   * 一页纸是给医生的：他要知道五年前做过什么，折叠按钮帮不上忙
   * （纸上的按钮点不动）。所以打印前把折叠状态强制打开。
   *
   * 监听 beforeprint 而不是只在按钮里开：患者更可能按 Ctrl+P，
   * 那条路径不经过我们的 onClick。
   */
  const [printAll, setPrintAll] = useState(false);
  useEffect(() => {
    const onBefore = () => setPrintAll(true);
    const onAfter = () => setPrintAll(false);
    window.addEventListener('beforeprint', onBefore);
    window.addEventListener('afterprint', onAfter);
    return () => {
      window.removeEventListener('beforeprint', onBefore);
      window.removeEventListener('afterprint', onAfter);
    };
  }, []);

  const doPrint = () => {
    setPrintAll(true);
    // 等一帧让展开后的 DOM 落地，否则可能打到折起来的版本
    requestAnimationFrame(() => {
      window.print();
      setPrintAll(false);
    });
  };

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, failure: null }));

    const fetchAll = async () => {
      const [rec, prof] = await Promise.all([
        getRecords(),
        getProfile(),
        loadHospitalCatalog(),
      ]);
      return { rec, prof };
    };

    let { rec, prof } = await fetchAll();

    // 与其它页一致：401 时自动重登一次再试
    const unauthorized =
      (!rec.ok && rec.failure.kind === 'unauthorized') ||
      (!prof.ok && prof.failure.kind === 'unauthorized');
    if (unauthorized) {
      const re = await ensureLogin();
      if (re.ok) ({ rec, prof } = await fetchAll());
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
  const meds = useMemo(() => {
    const all = state.records.flatMap((r) =>
      extractMedications(r.ocrText ?? '', r.hospitalCode, r.visitDate),
    );
    return dedupeByLatest(all);
  }, [state.records]);
  const checkups = useMemo(
    () => buildCheckupSuggestions(state.profile?.chronics ?? [], state.records),
    [state.profile, state.records],
  );

  const hospitalCount = useMemo(
    () => new Set(state.records.map((r) => r.hospitalCode)).size,
    [state.records],
  );

  /** 复制成纯文本，方便在线问诊时粘贴给医生 */
  const copyText = async () => {
    // 生成逻辑抽在 lib 里，可单测 —— 这段文字会被患者直接粘给医生，
    // 错了没人会核对，所以必须由测试守住
    const text = buildSummaryText({
      profile: state.profile,
      trends,
      records: state.records,
      medications: meds,
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

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
            : state.failure.kind === 'unauthorized'
              ? '登录已失效，请重试。'
              : state.failure.message}
        </p>
        <button
          type="button"
          onClick={load}
          className="mt-2 rounded-lg border border-amber-300 bg-surface px-3 py-1 text-xs text-amber-800 hover:bg-amber-100"
        >
          重试
        </button>
      </div>
    );
  }

  const p = state.profile;

  return (
    <div>
      {/* 屏幕上的操作条：打印与复制。打印时整条隐藏 */}
      <div className="no-print">
        <SubPageHeader
          title="就诊摘要"
          subtitle={`把你在 ${hospitalCount} 家医院的记录压成一页。打印出来带去门诊，或复制成文字发给医生。`}
          action={
            <>
              <button
                type="button"
                onClick={doPrint}
                className="h-9 rounded-lg bg-action px-3.5 text-sm font-medium text-white hover:bg-action-hover"
              >
                打印 / 存为 PDF
              </button>
              <button
                type="button"
                onClick={copyText}
                className="h-9 rounded-lg border border-gray-200 bg-surface px-3.5 text-sm text-gray-700 hover:border-brand-300"
              >
                {copied ? '已复制' : '复制文字'}
              </button>
            </>
          }
        />
      </div>

      {/* ============ 打印区 ============ */}
      <div ref={printRef} className="print-sheet rounded-xl border border-gray-200 bg-surface p-5">
        {/* 标题 */}
        <div className="border-b border-gray-200 pb-2">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-semibold text-gray-900">就诊摘要</span>
            <span className="text-xs text-gray-400">
              生成于 {new Date().toLocaleDateString('sv-SE')}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-gray-500">
            本人整理，供医生参考。数据来自本人上传的 {state.records.length} 份病历，
            覆盖 {hospitalCount} 家医院。
          </p>
        </div>

        {/* 第一屏：医生第一眼要看的 */}
        <div className="mt-3 grid gap-2 sm:grid-cols-3 print:grid-cols-3">
          <InfoBox
            label="过敏史"
            value={p?.allergies.length ? p.allergies.join('、') : '未记录'}
            emphasis={Boolean(p?.allergies.length)}
          />
          <InfoBox
            label="基础信息"
            value={[
              p?.age ? `${p.age} 岁` : null,
              genderLabel(p?.gender),
            ]
              .filter(Boolean)
              .join(' · ') || '未填写'}
          />
          <InfoBox
            label="慢病"
            value={p?.chronics.length ? p.chronics.join('、') : '未记录'}
          />
        </div>

        {/* 在用药 —— 医生开新药前必看 */}
        <Section title="在用药" hint="含跨院处方，按最近一次记录">
          {meds.length === 0 && (p?.medications.length ?? 0) === 0 ? (
            <p className="text-xs text-gray-400">未记录在服药物。</p>
          ) : (
            <ul className="space-y-1">
              {meds.map((m) => (
                <li key={`${m.name}-${m.visitDate}`} className="text-xs text-gray-700">
                  <span className="font-medium text-gray-900">{m.name}</span>
                  <span className="text-gray-500">
                    {' '}
                    {m.dose ?? ''} {m.frequency ?? ''} {m.timing ?? ''}
                  </span>
                  {m.visitDate ? (
                    <span className="text-gray-400"> · {m.visitDate}</span>
                  ) : null}
                </li>
              ))}
              {/* 档案里有、病历里没用法记录的也要列 —— 医生需要知道患者在吃 */}
              {p?.medications
                .filter((n) => !meds.some((m) => m.name.includes(n) || n.includes(m.name)))
                .map((n) => (
                  <li key={`only-${n}`} className="text-xs text-gray-700">
                    <span className="font-medium text-gray-900">{n}</span>
                    <span className="text-gray-400"> · 用法未记录</span>
                  </li>
                ))}
            </ul>
          )}
        </Section>

        {/* 指标 */}
        {trends.length > 0 ? (
          <Section title="近期指标" hint="按最近一次记录，括号内为测量日期">
            <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
              {trends.map((t) => {
                const last = t.points[t.points.length - 1]!;
                const abnormal = last.level !== 'normal';
                return (
                  <div key={t.name} className="flex items-baseline gap-1.5 text-xs">
                    <span className="text-gray-600">{t.name}</span>
                    <span
                      className={`font-semibold tabular-nums ${
                        abnormal ? 'text-amber-700' : 'text-gray-900'
                      }`}
                    >
                      {t.latest}
                    </span>
                    <span className="text-gray-400">{t.unit}</span>
                    {abnormal ? (
                      <span className="text-amber-600">
                        （{last.level === 'high' ? '偏高' : '偏低'}）
                      </span>
                    ) : null}
                    <span className="ml-auto text-gray-400">{last.date.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          </Section>
        ) : null}

        {/* 就诊史 */}
        <Section title="就诊记录" hint="按时间倒序，诊断为医生原话">
          {state.records.length === 0 ? (
            <p className="text-xs text-gray-400">暂无就诊记录。</p>
          ) : (
            /*
             * 6 条以内全出，超过就折。手机上十几条会把下面的
             * 「该做但尚未做的检查」推到三屏之外 —— 而那一块
             * 恰恰是医生开单前最该看到的。
             * 打印时 forceOpen 打开，一页纸上是完整的。
             */
            <Clamp
              items={[...state.records].sort((a, b) => b.visitDate.localeCompare(a.visitDate))}
              initial={6}
              itemKey={(r) => r.id}
              gap="space-y-1"
              unit="次"
              forceOpen={printAll}
              render={(r) => (
                /*
                 * 一行挤四段（日期 / 医院 / 科室 / 诊断）在窄屏上会把
                 * 诊断压成竖排的单字柱 —— 医院全名本来就长。
                 * 改成"时间地点一行、诊断另起一行"，打印出来也更好读。
                 */
                <div className="text-xs">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="shrink-0 whitespace-nowrap tabular-nums text-gray-500">
                      {r.visitDate}
                    </span>
                    <span className="text-gray-700">{hospitalName(r.hospitalCode)}</span>
                    {r.department ? <span className="text-gray-500">{r.department}</span> : null}
                  </div>
                  {r.diagnosisBrief ? (
                    <p className="mt-0.5 leading-relaxed text-gray-600">{r.diagnosisBrief}</p>
                  ) : null}
                </div>
              )}
            />
          )}
        </Section>

        {/* 待做检查 */}
        {checkups.filter((c) => c.status === 'DUE').length > 0 ? (
          <Section title="该做但尚未做的检查" hint="依据公开指南的复查间隔推算">
            <ul className="space-y-0.5">
              {checkups
                .filter((c) => c.status === 'DUE')
                .map((c) => (
                  <li key={c.name} className="text-xs text-gray-700">
                    <span className="font-medium text-gray-900">{c.name}</span>
                    <span className="text-gray-500">
                      {' '}
                      · 建议每 {c.intervalMonths} 个月
                      {c.lastDone ? `，上次 ${c.lastDone}` : ''}
                      {c.monthsSince !== null ? `（已 ${c.monthsSince} 个月）` : ''}
                    </span>
                  </li>
                ))}
            </ul>
          </Section>
        ) : null}

        {/* 页脚：来源与免责，打印也保留 */}
        <div className="mt-3 border-t border-gray-200 pt-2">
          <p className="text-3xs leading-relaxed text-gray-400">
            本页由患者本人使用「智诊通」整理，数据来源为患者自行上传的病历，
            未经医院核对。内容仅供医生参考，不作为诊断依据。
            如有出入请以医院原始记录为准。
          </p>
        </div>
      </div>
    </div>
  );
}

function InfoBox({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-2 ${
        emphasis ? 'border-red-200 bg-red-50/60' : 'border-gray-200 bg-gray-50/60'
      }`}
    >
      <div className={`text-3xs ${emphasis ? 'text-red-600' : 'text-gray-400'}`}>{label}</div>
      <div className={`mt-0.5 text-xs font-medium ${emphasis ? 'text-red-900' : 'text-gray-900'}`}>
        {value}
      </div>
    </div>
  );
}


function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-xs font-semibold text-brand-800">{title}</span>
        {hint ? <span className="text-3xs text-gray-400">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}
