/* ------------------------------------------------------------------
 * 今日清单 —— 患者每天打开应用看到的第一个页面
 *
 * ============ 为什么把它做成首页 ============
 *
 * 原来的首页是「问诊」输入框 —— 那是**有症状时**才用的。
 * 慢性病患者一年问诊几次，吃药却是每天两三次。
 * 每天真正要回答的问题是「今天我该做什么」，而不是「我怎么问诊」。
 *
 * 这一页把三样已经存在、但埋在病历页第 4 屏的东西聚合起来：
 *   · 今天几点吃什么药（从用法推导）
 *   · 今天/明天要做的事（预约、抽血要空腹、复查到期）
 *   · 需要处理的数据（待上传的报告）
 *
 * ============ 一条边界 ============
 *
 * 我们不记录「吃了没」。没有真实服药数据时，把已过时间点标灰是
 * 提示「这一档时间过了」，不是断言「你忘了吃药」。
 * 界面上用词必须区分这两件事 —— 前者是信息，后者是指责。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ensureLogin,
  getBookings,
  getProfile,
  getRecords,
  getReminders,
  hospitalName,
  type BackendFailure,
  type BookingOrder,
  type MedicalRecord,
  type PatientProfile,
  type ReminderTask,
} from '../lib/api';
import { buildDosePlan, isPast, summarizeDay, type DoseSlot } from '../lib/health/dosing';
import { dedupeByLatest, extractMedications } from '../lib/health/medications';

interface State {
  loading: boolean;
  failure: BackendFailure | null;
  records: MedicalRecord[];
  profile: PatientProfile | null;
  reminders: ReminderTask[];
  bookings: BookingOrder[];
}

const EMPTY: State = {
  loading: true,
  failure: null,
  records: [],
  profile: null,
  reminders: [],
  bookings: [],
};

export default function TodayPage() {
  const [state, setState] = useState<State>(EMPTY);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, failure: null }));

    const fetchAll = async () =>
      Promise.all([getRecords(), getProfile(), getReminders(), getBookings()]);

    let [rec, prof, rem, bk] = await fetchAll();

    const unauthorized =
      (!rec.ok && rec.failure.kind === 'unauthorized') ||
      (!prof.ok && prof.failure.kind === 'unauthorized') ||
      (!rem.ok && rem.failure.kind === 'unauthorized') ||
      (!bk.ok && bk.failure.kind === 'unauthorized');

    if (unauthorized) {
      const re = await ensureLogin();
      if (re.ok) [rec, prof, rem, bk] = await fetchAll();
    }

    const failure =
      (!rec.ok && rec.failure) ||
      (!prof.ok && prof.failure) ||
      (!rem.ok && rem.failure) ||
      (!bk.ok && bk.failure) ||
      null;

    if (failure) {
      setState({ ...EMPTY, loading: false, failure });
      return;
    }

    setState({
      loading: false,
      failure: null,
      records: rec.ok ? rec.data.records : [],
      profile: prof.ok ? prof.data : null,
      reminders: rem.ok ? rem.data : [],
      bookings: bk.ok ? bk.data : [],
    });
  }, []);

  useEffect(() => {
    void load();
    // 每分钟刷新一次「现在几点」，让已过的时间点自动变灰
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const plan = useMemo(() => {
    const all = state.records.flatMap((r) =>
      extractMedications(r.ocrText ?? '', r.hospitalCode, r.visitDate),
    );
    return buildDosePlan(dedupeByLatest(all));
  }, [state.records]);

  /** 今天与明天要处理的事项 */
  const agenda = useMemo(() => {
    const today = toDateStr(now);

    const todayItems: AgendaItem[] = [];
    const soonItems: AgendaItem[] = [];

    // 1. 提醒（复查、空腹、预约未确认）
    for (const r of state.reminders) {
      if (r.status !== 'PENDING') continue;
      const d = r.dueAt.slice(0, 10);

      /*
       * 关联预约的提醒：预约已经过去，提醒就失去意义。
       *
       * 实测发现的问题：今天（11-16）打开首页，看到
       * 「明天早上空腹抽血，今晚 22 点后禁食」—— 但它关联的预约
       * 是 11-15 08:30，早就过了。提醒是两天前生成的，一直挂着没清。
       *
       * 这类提醒不像复查提醒那样"过期更该做"：抽血这件事没去就是没去，
       * 留着只会让人以为明天真要抽血。所以按关联预约是否过期来判断。
       */
      if (r.refType === 'BOOKING' && r.refId != null) {
        const linked = state.bookings.find((b) => b.id === r.refId);
        if (linked && new Date(linked.visitTime).getTime() < now.getTime()) {
          continue; // 关联预约已过 → 该提醒作废
        }
      }

      const item: AgendaItem = {
        key: `rem-${r.id}`,
        title: r.title,
        detail: r.detail ?? r.reason ?? '',
        kind: 'reminder',
      };
      /*
       * 提醒与预约的分组规则不同：
       *   · 预约是"某天要去"，过期就作废 → 过期不显示
       *   · 提醒是"该做但没做"，过期意味着**更该做** → 过期显示在今天
       * 这是催办语义，不是日程语义。
       */
      if (d <= today) todayItems.push(item);
      else soonItems.push(item);
    }

    // 2. 预约
    for (const b of state.bookings) {
      if (b.status !== 'CREATED' && b.status !== 'CONFIRMED') continue;
      const d = b.visitTime.slice(0, 10);

      /*
       * 已过期的预约不进今日清单。
       *
       * 实测发现的问题：昨天（11-15）的预约被算进「今天」，
       * 患者打开看到一条已经过去的就诊安排，只会困惑。
       * 过期就是过期，不该再占今天的注意力 —— 未确认的过期预约
       * 同样不再提醒，因为已经没机会确认了。
       */
      if (d < today) continue;

      const item: AgendaItem = {
        key: `bk-${b.id}`,
        title: `${hospitalName(b.hospitalCode)} ${b.department}`,
        detail: `${b.visitTime.slice(5, 10)} ${b.visitTime.slice(11, 16)} 就诊${
          b.status === 'CREATED' ? '（待确认，到院请在自助机取号）' : ''
        }`,
        kind: b.status === 'CREATED' ? 'warn' : 'booking',
        href: '/records',
      };
      if (d === today) todayItems.push(item);
      else soonItems.push(item);
    }

    return { todayItems, soonItems };
  }, [state.reminders, state.bookings, now]);

  const dateLabel = `${now.getMonth() + 1} 月 ${now.getDate()} 日`;
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];

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
        <div className="text-sm font-medium text-amber-900">暂时读不到你的数据</div>
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
          className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs text-amber-800 hover:bg-amber-100"
        >
          重试
        </button>
      </div>
    );
  }

  const medCount = plan.slots.reduce((n, s) => n + s.meds.length, 0);
  const hasAnything = plan.slots.length > 0 || agenda.todayItems.length > 0;

  return (
    <div className="space-y-5">
      {/* 顶部：今天 */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">
          今天要做什么
        </h1>
        <p className="mt-1.5 text-sm text-gray-500">
          {dateLabel} · {weekday}
          {medCount > 0 ? ` · 今天共 ${plan.slots.length} 个服药时间点` : ''}
        </p>
      </div>

      {!hasAnything ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5 text-center">
          <p className="text-sm text-gray-500">今天没有安排。</p>
          <p className="mt-1 text-xs text-gray-400">
            上传一份病历，我就能帮你把要吃的药和该做的检查整理出来。
          </p>
          <Link
            to="/records"
            className="mt-3 inline-flex h-9 items-center rounded-lg bg-brand-700 px-4 text-sm font-medium text-white hover:bg-brand-800"
          >
            上传病历
          </Link>
        </div>
      ) : null}

      {/* 今天的药 */}
      {plan.slots.length > 0 ? <DoseSection slots={plan.slots} now={now} /> : null}

      {/* 用法未记录的药：单独列出，不猜 */}
      {plan.unscheduled.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <div className="text-xs font-medium text-amber-900">这些药病历里没写用法</div>
          <p className="mt-1 text-xs leading-relaxed text-amber-800">
            {plan.unscheduled.map((u) => u.name).join('、')}
            —— 建议按药盒说明服用，有疑问问医生或药师。
          </p>
        </div>
      ) : null}

      {/* 今天 + 接下来 */}
      {agenda.todayItems.length > 0 ? (
        <AgendaSection title="今天" items={agenda.todayItems} highlight />
      ) : null}
      {agenda.soonItems.length > 0 ? (
        <AgendaSection title="接下来" items={agenda.soonItems} />
      ) : null}

      {/* 底部入口 */}
      <div className="flex flex-wrap gap-2 pt-1">
        <Link
          to="/chat"
          className="inline-flex h-9 items-center rounded-lg bg-brand-700 px-4 text-sm font-medium text-white hover:bg-brand-800"
        >
          去问诊
        </Link>
        <Link
          to="/health"
          className="inline-flex h-9 items-center rounded-lg border border-gray-200 bg-white px-4 text-sm text-gray-700 hover:border-brand-300"
        >
          健康管家
        </Link>
        <Link
          to="/summary"
          className="inline-flex h-9 items-center rounded-lg border border-gray-200 bg-white px-4 text-sm text-gray-700 hover:border-brand-300"
        >
          就诊摘要
        </Link>
      </div>

      <p className="text-xs leading-relaxed text-gray-400">
        服药时间由病历上的频次推算，可自行调整；具体以医嘱和药盒说明为准。
        我们不记录你是否服药，这里只提醒「什么时候该吃」。
      </p>
    </div>
  );
}

/* ============================ 服药时间表 ============================ */

function DoseSection({ slots, now }: { slots: DoseSlot[]; now: Date }) {
  return (
    <section>
      <SectionTitle>
        今天的药
        <span className="ml-2 text-xs font-normal text-gray-400">{summarizeDay(slots)}</span>
      </SectionTitle>

      <div className="space-y-2">
        {slots.map((slot) => {
          const past = isPast(slot.time, now);
          return (
            <div
              key={slot.time}
              className={`flex gap-3 rounded-xl border p-3 ${
                past ? 'border-gray-200 bg-gray-50' : 'border-brand-200 bg-brand-50/40'
              }`}
            >
              <div className="w-14 shrink-0">
                <div
                  className={`text-base font-semibold tabular-nums ${
                    past ? 'text-gray-400' : 'text-brand-800'
                  }`}
                >
                  {slot.time}
                </div>
                <div className="text-[10px] text-gray-400">
                  {/* 用词刻意区分：时间过了 ≠ 你没吃 */}
                  {past ? '时间已过' : '待服'}
                </div>
              </div>

              <div className="min-w-0 flex-1">
                {slot.meds.map((m) => (
                  <div key={m.name} className="text-sm leading-relaxed">
                    <span className={`font-medium ${past ? 'text-gray-500' : 'text-gray-900'}`}>
                      {m.name}
                    </span>
                    {m.dose ? <span className="ml-1 text-xs text-gray-500">{m.dose}</span> : null}
                    {m.timing ? (
                      <span className="ml-1 text-xs text-gray-400">（{m.timing}）</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ============================ 待办 ============================ */

interface AgendaItem {
  key: string;
  title: string;
  detail: string;
  kind: 'reminder' | 'booking' | 'warn';
  href?: string;
}

function AgendaSection({
  title,
  items,
  highlight = false,
}: {
  title: string;
  items: AgendaItem[];
  highlight?: boolean;
}) {
  return (
    <section>
      <SectionTitle>
        {title}
        <span className="ml-2 text-xs font-normal text-gray-400">{items.length} 项</span>
      </SectionTitle>

      <div className="space-y-2">
        {items.map((it) => {
          const dot =
            it.kind === 'warn' ? 'bg-amber-500' : it.kind === 'booking' ? 'bg-brand-600' : 'bg-gray-400';
          const box = highlight
            ? it.kind === 'warn'
              ? 'border-amber-200 bg-amber-50/60'
              : 'border-gray-200 bg-white'
            : 'border-gray-200 bg-white';
          return (
            <div key={it.key} className={`flex gap-2.5 rounded-xl border p-3 ${box}`}>
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium leading-snug text-gray-900">{it.title}</div>
                <p className="mt-0.5 text-xs leading-relaxed text-gray-600">{it.detail}</p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 text-sm font-medium text-gray-700">{children}</h2>;
}

/* ============================ 日期工具 ============================ */

function toDateStr(d: Date): string {
  return d.toLocaleDateString('sv-SE');
}

