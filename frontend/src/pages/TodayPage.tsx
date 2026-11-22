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
 * 「吃了没」由**患者自己**记：每档有「已服用 / 已跳过」两个动作，
 * 记录只落在本机（见 lib/health/dose-log.ts）。
 *
 * 我们仍然不知道他到底吃没吃 —— 记的是"患者点了什么"，不是"患者做了什么"。
 * 所以界面上一律不出现「漏服」「未服药」：没点记录只是没点记录，
 * 不是证据。用词必须守住这条线 —— 前者是信息，后者是指责。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AskBar } from '../components/home/AskBar';
import { NextBookingBanner, type UpcomingBooking } from '../components/home/NextBookingBanner';
import { NoticeBar } from '../components/home/NoticeBar';
import { TodayHero } from '../components/home/TodayHero';
import { Card } from '../components/ui/Card';
import { Callout } from '../components/ui/Callout';
import { SectionTitle } from '../components/ui/SectionTitle';
import {
  ensureLogin,
  getBookings,
  getProfile,
  getRecords,
  getReminders,
  hospitalName,
  loadHospitalCatalog,
  type BackendFailure,
  type BookingOrder,
  type MedicalRecord,
  type PatientProfile,
  type ReminderTask,
} from '../lib/api';
import { buildDosePlan, countDistinctMeds, slotTemporal, summarizeDay, type DoseSlot } from '../lib/health/dosing';
import {
  getDayStatus,
  readDoseLog,
  setDoseStatus,
  summarizeProgress,
  todayStr,
  writeDoseLog,
  type DoseLog,
  type DoseStatus,
} from '../lib/health/dose-log';
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
  /*
   * 服药记录从 localStorage 读一次，之后由点击维护。
   * 不放在 state 的 EMPTY 里：那是后端数据的容器，这份是纯本地的，
   * 后端挂了也该照常显示（患者最需要它的时刻，往往正是别的都不响的时刻）。
   */
  const [doseLog, setDoseLog] = useState<DoseLog>(() => readDoseLog());

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, failure: null }));

    const fetchAll = async () =>
      /*
       * 院区目录一起拉。
       *
       * 原来这页从不 loadHospitalCatalog，而标题里又调 hospitalName() ——
       * 目录没加载时 hospitalName 只能返回编码本身，于是首页会出现
       * "H001 消化内科"这种内部编号。患者看不懂，演示时也不好解释。
       * 失败不影响其他数据：降级成编码而已，所以放进同一个 Promise.all。
       */
      Promise.all([getRecords(), getProfile(), getReminders(), getBookings(), loadHospitalCatalog()]);

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

  const today = todayStr(now);
  const todayStatus = getDayStatus(doseLog, today);
  const progress = summarizeProgress(
    plan.slots.map((s) => s.id),
    todayStatus,
  );

  /**
   * 记录一档的状态。
   *
   * <p>点同一个状态 = 取消（见 dose-log.ts）。写盘失败不抛给界面 ——
   * "这次没记住"比"整页报错"轻得多。
   */
  const markSlot = useCallback(
    (slotId: string, next: DoseStatus | null) => {
      setDoseLog((prev) => {
        const updated = setDoseStatus(prev, todayStr(new Date()), slotId, next);
        writeDoseLog(updated);
        return updated;
      });
    },
    [],
  );

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
        /*
         * 指向「到院」而不是「我的病历」。
         *
         * 原来跳病历页，那里只有一行预约记录 —— 患者真正想知道的
         * "今天去哪、还要等多久"一个都没有。「到院」页就是为这一刻做的。
         */
        href: '/visit',
      };
      if (d === today) todayItems.push(item);
      else soonItems.push(item);
    }

    return { todayItems, soonItems };
  }, [state.reminders, state.bookings, now]);

  /**
   * 下一次就诊。
   *
   * <p>首页顶部的横条只放一条最该知道的预约：过期的、已取消的都排除，
   * 按时间升序取第一条。没有就整条不渲染。
   */
  const nextBooking = useMemo<UpcomingBooking | null>(() => {
    const today = toDateStr(now);
    const upcoming = state.bookings
      .filter(
        (b) =>
          (b.status === 'CREATED' || b.status === 'CONFIRMED') &&
          new Date(b.visitTime).getTime() >= now.getTime(),
      )
      .sort((a, b) => a.visitTime.localeCompare(b.visitTime));
    const b = upcoming[0];
    if (!b) return null;

    /*
     * 「还剩几天」按日历天数算，不按 24 小时算。
     * 今晚 23:00 打开、预约明天 09:00 就诊：实际只差 10 小时，
     * 但患者说的是"明天"。拿毫秒除会得到 0 天，横条上就写成"今天"了。
     */
    const visitDay = new Date(`${b.visitTime.slice(0, 10)}T00:00:00`);
    const todayDay = new Date(`${today}T00:00:00`);
    const daysUntil = Math.max(
      0,
      Math.round((visitDay.getTime() - todayDay.getTime()) / 86_400_000),
    );

    return {
      department: b.department,
      hospital: hospitalName(b.hospitalCode),
      visitTime: b.visitTime,
      today: b.visitTime.slice(0, 10) === today,
      daysUntil,
      pending: b.status === 'CREATED',
    };
  }, [state.bookings, now]);

  if (state.loading) {
    return (
      /*
       * 骨架必须包含英雄区，且高度接近。
       * 原来这里是 3 个 h-24，内容一到位整页会往下跳一截 ——
       * 滑到一半被顶开比"多看一眼骨架"更难受。
       */
      <div className="space-y-5">
        <div className="h-[300px] animate-pulse rounded-3xl bg-gray-100" />
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-gray-100" />
          ))}
        </div>
      </div>
    );
  }

  if (state.failure) {
    return (
      /*
       * 后端读不到数据用中性灰虚线，不是琥珀。
       * 琥珀在这个界面里表示"你要做点什么"（空腹、复查到期）；
       * 服务没起来是"我们这边没读到"，把它染成警告色，
       * 真正的医疗提醒就会被一起忽略。
       */
      <Callout
        tone="neutral"
        title="暂时读不到你的数据"
        action={
          <button
            type="button"
            onClick={load}
            className="rounded-lg border border-gray-300 bg-surface px-3 py-1 text-xs text-gray-700 hover:border-gray-400"
          >
            重试
          </button>
        }
      >
        <span className="text-xs">
          {state.failure.kind === 'unreachable'
            ? '后端未启动。在 backend 目录执行 mvn spring-boot:run 后再试。'
            : state.failure.kind === 'unauthorized'
              ? '登录已失效，请重试。'
              : state.failure.message}
        </span>
      </Callout>
    );
  }

  const medCount = countDistinctMeds(plan.slots);
  // 只算「今天」：明天有预约不代表今天有安排，标题不能替用户把话说满
  const hasAnything = plan.slots.length > 0 || agenda.todayItems.length > 0;

  return (
    <>
      {/*
        pb-20：给底部那条悬浮的「问一句」留位置。
        不留的话，最后一行说明会被它压住 —— 而那行字恰好是免责说明，
        是这个产品最不能含糊的一句话。
      */}
      <div className="space-y-5 pb-20">
        {/* 公告放在英雄区之前：院方停诊/时间调整这类信息，先于"今天吃什么药" */}
        <NoticeBar />

        {nextBooking ? <NextBookingBanner booking={nextBooking} /> : null}

        <TodayHero
          now={now}
          slotsTotal={plan.slots.length}
          medCount={medCount}
          taken={progress.taken}
          skipped={progress.skipped}
          todayCount={agenda.todayItems.length}
          hasAnything={hasAnything}
          hasVisitToday={nextBooking?.today ?? false}
          hasUpcomingBooking={nextBooking != null}
        />

      {/* 空态不再单独占一张卡 —— 英雄区已经说了"今天没有安排"并给出唯一动作，
          两张卡说同一句话只会让人以为漏翻了什么 */}

      {/* 今天的药 */}
      {plan.slots.length > 0 ? (
        <DoseSection
          slots={plan.slots}
          now={now}
          status={todayStatus}
          onMark={markSlot}
          progressText={progress.text}
        />
      ) : null}

      {/* 用法未记录的药：单独列出，不猜 */}
      {plan.unscheduled.length > 0 ? (
        <Callout tone="neutral" title="病历里未具体说明这些药的用法" dense>
          {plan.unscheduled.map((u) => u.name).join('、')}
          —— 建议按药盒说明服用，有疑问问医生或药师。
        </Callout>
      ) : null}

      {/* 今天 + 接下来 */}
      {agenda.todayItems.length > 0 ? (
        <AgendaSection title="今天" items={agenda.todayItems} highlight />
      ) : null}
      {agenda.soonItems.length > 0 ? (
        <AgendaSection title="接下来" items={agenda.soonItems} />
      ) : null}

        {/* 底部入口不再重复导航 —— 六个快捷入口已经在英雄区里 */}
        <p className="text-xs leading-relaxed text-gray-500">
          服药时间来自病历上的频次与时机。病历只写「饭后」「睡前」时，这里给的是一段时间
          （如早饭后），不是某个钟点 —— 按你那天实际的吃饭时间把握即可。
          「已服用」只是你的自记，留在本机，不会上传，也不代替医嘱。
        </p>
      </div>

      <AskBar />
    </>
  );
}

/* ============================ 服药时间表 ============================ */

/**
 * 今天的药。
 *
 * <p>每一档有两个动作：**已服用 / 已跳过**。
 * 原来这里只有一句「时间已过」—— 患者想知道的是"我吃了没"，
 * 而界面只回答"时间过了"，等于让他凭记忆。
 *
 * <p>三档视觉对应三种现实：
 *   · 已服用  → 灰掉并打勾，不再占注意力
 *   · 已跳过  → 灰掉并标「已跳过」，同样不再催
 *   · 待服    → 有色块。模糊时间显示「早饭后 · 约 07:30–09:00」，
 *               精确时间显示「08:30」，并且**不把模糊档印成钟点**
 */
/**
 * 把病历上的时机词翻译成"手上该怎么吃"。
 *
 * <p>「餐后服用」四个字，实际要做的事是"先吃点东西再吃药"——但患者
 * 看到"餐后"经常理解成"吃完饭以后随便什么时候"。这一句话就是把名词
 * 变成动作。
 *
 * <p>只复述病历里写了什么，不添加病历没写的医嘱（不写"空腹伤胃"这种
 * 它没说过的因果）。同一句话只说一次：三档都写"餐后"不该印三遍。
 */
function doseTips(slots: DoseSlot[]): string[] {
  const said = new Map<string, string>();

  for (const slot of slots) {
    for (const med of slot.meds) {
      const raw = med.timing?.trim();
      if (!raw) continue;

      const action = /不可空腹|忌空腹|不宜空腹|避免空腹/.test(raw)
        ? '别空腹吃：先吃点东西，再吃药。'
        : /空腹|餐前|饭前/.test(raw)
          ? '先吃药，再吃饭。'
          : /餐后|饭后/.test(raw)
            ? '先吃点东西再吃药，别空腹。'
            : /睡前|临睡/.test(raw)
              ? '睡前吃，吃完就别再吃东西。'
              : /晨起|清晨|早上/.test(raw)
                ? '起床后先吃，再吃早饭。'
                : null;

      if (!action) continue;
      if (!said.has(action)) said.set(action, `病历写的是「${raw}」：${action}`);
    }
  }

  return [...said.values()];
}

function DoseSection({
  slots,
  now,
  status,
  onMark,
  progressText,
}: {
  slots: DoseSlot[];
  now: Date;
  status: Record<string, DoseStatus>;
  onMark: (slotId: string, next: DoseStatus | null) => void;
  progressText: string;
}) {
  const tips = doseTips(slots);

  return (
    <section>
      <SectionTitle>今天要吃哪些药</SectionTitle>

      {/*
        摘要与进度分两行、两种语气：
        第一行说"今天一共多少药"（客观事实），第二行说"你记了几档"（进度）。
        原来这两句挤在标题右边，读起来像一句很长的话，谁都不突出。

        一条都没记录时 progressText 是空的 —— "今天 3 档，都还没到记录的
        时候"这种话既不是信息也不是提醒，只会占掉一行注意力。
      */}
      <p className="mb-1 text-xs leading-relaxed text-gray-600">{summarizeDay(slots)}</p>

      {/*
        把「餐后」「空腹」翻译成动作。
        病历写"餐后服用"，很多人照样空腹吞 —— 一句话的差别是胃受不受得了。
        只复述病历写了什么，不加它没写的医嘱。
      */}
      {tips.length > 0 ? (
        <div className="mb-2 space-y-1 rounded-lg border border-alert-line bg-alert-soft px-2.5 py-2">
          {tips.map((t) => (
            <p key={t} className="text-xs leading-relaxed text-gray-800">
              {t}
            </p>
          ))}
        </div>
      ) : null}

      {progressText ? (
        <p className="mb-2 text-xs leading-relaxed text-gray-500">{progressText}</p>
      ) : null}

      <div className="stagger-1 space-y-2">
        {slots.map((slot) => {
          const state = status[slot.id];
          const temporal = slotTemporal(slot, now);
          const done = state === 'taken' || state === 'skipped';

          /*
           * 三档含义，不能混用：
           *   done  → 灰（已处理，别再吸引注意力）
           *   now   → 青绿浅底 + 左侧强调条（就是现在这一段，最该看）
           *   其它  → 中性
           * 只有"正在这一段"上色：一直在闪的东西等于一直在喊，
           * 喊久了没人听。
           */
          const tone = done ? 'muted' : temporal === 'now' ? 'brand' : 'neutral';

          return (
            <Card key={slot.id} as="div" pad="sm" tone={tone} accent={!done && temporal === 'now'}>
              <div className="flex gap-3">
                <div className="w-16 shrink-0">
                  {slot.kind === 'exact' ? (
                    <div
                      className={`text-base font-semibold tabular-nums ${
                        done ? 'text-gray-400' : 'text-brand-800'
                      }`}
                    >
                      {slot.label}
                    </div>
                  ) : (
                    /*
                     * 模糊档：大字是「早饭后」，小字才是窗口。
                     * 反过来写（大字印 08:00）就是在替医生下医嘱。
                     */
                    <div
                      className={`text-sm font-semibold leading-snug ${
                        done ? 'text-gray-400' : 'text-brand-800'
                      }`}
                    >
                      {slot.label}
                    </div>
                  )}
                  <div
                    className={`mt-0.5 text-2xs ${temporal === 'now' && !done ? 'font-medium text-brand-700' : 'text-gray-500'}`}
                  >
                    {state === 'taken'
                      ? '已服用'
                      : state === 'skipped'
                        ? '已跳过'
                        : slot.kind === 'fuzzy'
                          ? temporal === 'now'
                            ? '就是现在'
                            : temporal === 'passed'
                              ? '这一段已过'
                              : '还没到'
                          : temporal === 'passed'
                            ? '时间已过'
                            : '待服'}
                  </div>
                </div>

                <div className="min-w-0 flex-1">
                  {slot.kind === 'fuzzy' && slot.hint ? (
                    <p className="mb-1 text-2xs text-gray-400">{slot.hint}</p>
                  ) : null}
                  {slot.meds.map((m) => (
                    <div key={m.name} className="text-sm leading-relaxed">
                      <span className={`font-medium ${done ? 'text-gray-500' : 'text-gray-900'}`}>
                        {m.name}
                      </span>
                      {m.dose ? <span className="ml-1 text-xs text-gray-500">{m.dose}</span> : null}
                      {m.timing ? (
                        <span className="ml-1 text-xs text-gray-400">（{m.timing}）</span>
                      ) : null}
                    </div>
                  ))}

                  <div className="mt-1.5 flex gap-1.5">
                    {/*
                      两个动作始终都在，不随时间变化。
                      按时间显隐按钮的话，"早上忘了点、晚上想起来"就再也补记不了 ——
                      而补记恰恰是最常见的真实情况。
                    */}
                    <button
                      type="button"
                      onClick={() => onMark(slot.id, state === 'taken' ? null : 'taken')}
                      aria-pressed={state === 'taken'}
                      className={`rounded-lg border px-2 py-0.5 text-xs ${
                        state === 'taken'
                          ? 'border-action bg-action text-white'
                          : 'border-gray-300 bg-surface text-gray-600 hover:border-brand-400 hover:text-brand-700'
                      }`}
                    >
                      已服用
                    </button>
                    <button
                      type="button"
                      onClick={() => onMark(slot.id, state === 'skipped' ? null : 'skipped')}
                      aria-pressed={state === 'skipped'}
                      className={`rounded-lg border px-2 py-0.5 text-xs ${
                        state === 'skipped'
                          ? 'border-gray-400 bg-gray-200 text-gray-700'
                          : 'border-gray-200 bg-surface text-gray-500 hover:border-gray-400'
                      }`}
                    >
                      跳过
                    </button>
                  </div>
                </div>
              </div>
            </Card>
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
      <SectionTitle count={`${items.length} 项`}>{title}</SectionTitle>

      <div className="stagger-1 space-y-2">
        {items.map((it) => {
          /*
           * 颜色按"这件事是什么"分，不按"它要不要紧"分：
           *   预约（已确认）→ 蓝。时间是这一页最需要被一眼找到的信息
           *   待确认预约   → 琥珀。还需要你打个电话 / 到自助机取号
           *   提醒         → 琥珀。复查到期、空腹禁食都属于"该做点什么"
           * 用一条左侧强调条而不是整块铺色：一列浅黄铺满之后，
           * 每一块都在喊，等于都没喊。
           */
          const tone = it.kind === 'booking' ? 'appt' : 'alert';
          const badge = it.kind === 'booking' ? '预约' : it.kind === 'warn' ? '待确认' : '提醒';
          return (
            <Card key={it.key} pad="sm" tone={tone} accent={highlight || it.kind !== 'reminder'}>
              <div className="flex items-start gap-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <div className="text-sm font-medium leading-snug text-gray-900">
                      {it.title}
                    </div>
                    <span
                      className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium ${
                        it.kind === 'booking' ? 'bg-appt-solid text-white' : 'bg-alert-solid text-white'
                      }`}
                    >
                      {badge}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-gray-700">{it.detail}</p>
                  {/*
                    可点的入口。
                    原来 detail 里写着「请打开预约详情确认或取消」，
                    但整块是死的、没有链接 —— 一句话指了个不存在的地方，
                    比不说更让人恼火。现在这句话后面真的能点。
                  */}
                  {it.href ? (
                    <Link
                      to={it.href}
                      className="mt-1 inline-block text-xs font-medium text-brand-700 underline underline-offset-2"
                    >
                      查看详情
                    </Link>
                  ) : null}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

/* ============================ 日期工具 ============================ */

function toDateStr(d: Date): string {
  return d.toLocaleDateString('sv-SE');
}

