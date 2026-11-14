/* ------------------------------------------------------------------
 * 我的病历 —— 跨院时间轴（真实数据）
 *
 * 这一页从"说明性页面"改成了**真读后端**：就诊记录按院区分组、
 * 提醒任务可标记完成。这是 HANDOFF §二·五 里排第一的补齐项 ——
 * 不接后端，「跨院」这个核心卖点在演示里根本看不见。
 *
 * 三个刻意的设计：
 *
 * 1. **后端不可用时降级，不白屏**。
 *    病历读不到仍然展示隐私说明，并明确提示"后端未启动"。
 *    整个页面不该被一个附属接口拖垮。
 *
 * 2. **院区用颜色区分**。
 *    「跨院」的关键是"这两个东西来自不同医院"，颜色是最快的传达方式。
 *
 * 3. **每条提醒都显示 reason**。
 *    这是提醒引擎的核心主张：不是闹钟，是"系统理解了你的记录后想到的"。
 *    藏着不显示等于白做。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ensureLogin,
  getProfile,
  getRecords,
  getReminders,
  markReminder,
  hospitalName,
  shortDate,
  type BackendFailure,
  type MedicalRecord,
  type PatientProfile,
  type ReminderTask,
} from '../lib/api';

/** 院区配色。同一个 code 永远同一个颜色，跨页面一致 */
const HOSPITAL_TONE: Record<string, string> = {
  'MOCK-A': 'bg-brand-50 text-brand-700 border-brand-200',
  'MOCK-B': 'bg-violet-50 text-violet-700 border-violet-200',
};

const TONE_FALLBACK = 'bg-gray-50 text-gray-600 border-gray-200';

interface DataState {
  loading: boolean;
  failure: BackendFailure | null;
  records: MedicalRecord[];
  reminders: ReminderTask[];
  profile: PatientProfile | null;
}

const EMPTY: DataState = {
  loading: true,
  failure: null,
  records: [],
  reminders: [],
  profile: null,
};

export default function RecordsPage() {
  const [state, setState] = useState<DataState>(EMPTY);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, failure: null }));

    const auth = await ensureLogin();
    if (!auth.ok) {
      setState({ ...EMPTY, loading: false, failure: auth.failure });
      return;
    }

    // 并行拉三份；任何一份失败都优先显示失败原因（后端挂了时三份都会失败）
    const [rec, rem, prof] = await Promise.all([getRecords(), getReminders(), getProfile()]);

    const failure = !rec.ok ? rec.failure : !rem.ok ? rem.failure : !prof.ok ? prof.failure : null;
    if (failure) {
      setState({ ...EMPTY, loading: false, failure });
      return;
    }

    setState({
      loading: false,
      failure: null,
      records: rec.ok ? rec.data.records : [],
      reminders: rem.ok ? rem.data : [],
      profile: prof.ok ? prof.data : null,
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onMark = async (id: number, action: 'done' | 'skip') => {
    // 乐观更新：先本地移除，失败再恢复。等 3 秒才消失的按钮用户会连点
    const prev = state.reminders;
    setState((s) => ({ ...s, reminders: s.reminders.filter((r) => r.id !== id) }));
    const r = await markReminder(id, action);
    if (!r.ok) setState((s) => ({ ...s, reminders: prev }));
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">我的病历</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-500">
          把散在各家医院的记录放在一起，换医院时不用再凭记忆复述。
        </p>
      </div>

      {state.loading ? <Skeleton /> : null}

      {!state.loading && state.failure ? (
        <BackendNotice failure={state.failure} onRetry={load} />
      ) : null}

      {!state.loading && !state.failure ? (
        <>
          {state.profile ? <ProfileStrip profile={state.profile} /> : null}
          <RemindersSection
            items={state.reminders}
            onMark={onMark}
          />
          <TimelineSection records={state.records} />
        </>
      ) : null}

      {/* 隐私说明常驻：即使后端挂了，这条也是我们最想让用户看到的 */}
      <PrivacyNote />

      <Link
        to="/"
        className="inline-flex h-10 items-center rounded-lg border border-gray-200 bg-white px-4 text-sm text-gray-700 hover:border-brand-300"
      >
        返回问诊
      </Link>
    </div>
  );
}

/* ============================ 子组件 ============================ */

function Skeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-20 animate-pulse rounded-xl bg-gray-100" />
      ))}
    </div>
  );
}

/**
 * 后端不可用时的提示。
 *
 * <p>三种失败给三种话术：没启动 → 告诉你去起后端；
 * 未启用 → 说明这是配置选择；其他 → 说清原因。
 * 一律说"加载失败"是最没用的提示。
 */
function BackendNotice({
  failure,
  onRetry,
}: {
  failure: BackendFailure;
  onRetry: () => void;
}) {
  const text =
    failure.kind === 'unreachable'
      ? '后端未启动，病历与提醒无法加载。在 backend 目录执行 mvn spring-boot:run 后点重试。'
      : failure.kind === 'disabled'
        ? '本次部署未启用后端（BACKEND_BASE_URL=none），病历与提醒不可用。'
        : failure.kind === 'unauthorized'
          ? '登录已失效，请重新加载页面。'
          : failure.message;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="text-sm font-medium text-amber-900">无法读取病历数据</div>
      <p className="mt-1 text-xs leading-relaxed text-amber-800">{text}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs text-amber-800 hover:bg-amber-100"
      >
        重试
      </button>
    </div>
  );
}

function ProfileStrip({ profile }: { profile: PatientProfile }) {
  const items: Array<[string, string]> = [];
  if (profile.age != null) items.push(['年龄', `${profile.age} 岁`]);
  if (profile.gender) items.push(['性别', profile.gender === 'MALE' ? '男' : profile.gender === 'FEMALE' ? '女' : '其他']);
  if (profile.allergies.length) items.push(['过敏史', profile.allergies.join('、')]);
  if (profile.chronics.length) items.push(['慢病', profile.chronics.join('、')]);

  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-xl border border-gray-200 bg-white px-4 py-3">
      {items.map(([k, v]) => (
        <div key={k} className="text-sm">
          <span className="text-xs text-gray-400">{k}</span>
          <span className="ml-1.5 text-gray-800">{v}</span>
        </div>
      ))}
    </div>
  );
}

function RemindersSection({
  items,
  onMark,
}: {
  items: ReminderTask[];
  onMark: (id: number, action: 'done' | 'skip') => void;
}) {
  if (items.length === 0) {
    return (
      <section>
        <SectionTitle>接下来要做的事</SectionTitle>
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-400">
          暂时没有待办的提醒。
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionTitle>接下来要做的事（{items.length}）</SectionTitle>
      <div className="space-y-2">
        {items.map((r) => (
          <div key={r.id} className="rounded-xl border border-gray-200 bg-white p-4">
            <div className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-gray-900">{r.title}</div>
                {r.detail ? (
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">{r.detail}</p>
                ) : null}
                {/*
                  reason 是提醒引擎的核心主张：不是闹钟，是"系统理解了
                  你的记录后想到的"。藏在数据库里等于白做，所以显式展示。
                */}
                {r.reason ? (
                  <p className="mt-1.5 rounded bg-gray-50 px-2 py-1 text-xs leading-relaxed text-gray-500">
                    依据：{r.reason}
                  </p>
                ) : null}
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-gray-400">{shortDate(r.dueAt)}</span>
                  <button
                    type="button"
                    onClick={() => onMark(r.id, 'done')}
                    className="ml-auto rounded px-2 py-0.5 text-xs text-brand-700 hover:bg-brand-50"
                  >
                    已完成
                  </button>
                  <button
                    type="button"
                    onClick={() => onMark(r.id, 'skip')}
                    className="rounded px-2 py-0.5 text-xs text-gray-400 hover:bg-gray-100"
                  >
                    忽略
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * 跨院时间轴。
 *
 * <p>按院区分组而不是纯按时间排：这个项目的核心主张就是
 * "这些记录来自不同医院"，按院区分组才看得出来。
 * 每组内部再按时间倒序。
 */
function TimelineSection({ records }: { records: MedicalRecord[] }) {
  if (records.length === 0) {
    return (
      <section>
        <SectionTitle>跨院就诊记录</SectionTitle>
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
          还没有上传过病历。
        </div>
      </section>
    );
  }

  const groups = new Map<string, MedicalRecord[]>();
  for (const r of records) {
    const list = groups.get(r.hospitalCode) ?? [];
    list.push(r);
    groups.set(r.hospitalCode, list);
  }
  const hospitalCount = groups.size;

  return (
    <section>
      <SectionTitle>
        跨院就诊记录
        <span className="ml-2 text-xs font-normal text-gray-400">
          共 {records.length} 次 · {hospitalCount} 家医院
        </span>
      </SectionTitle>

      <div className="space-y-3">
        {[...groups.entries()].map(([code, list]) => (
          <div key={code} className="rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center gap-2 border-b border-gray-100 px-4 py-2.5">
              <span
                className={
                  'rounded border px-1.5 py-0.5 text-xs ' +
                  (HOSPITAL_TONE[code] ?? TONE_FALLBACK)
                }
              >
                {hospitalName(code)}
              </span>
              <span className="text-xs text-gray-400">{list.length} 次就诊</span>
            </div>

            <ol className="divide-y divide-gray-50">
              {[...list]
                .sort((a, b) => b.visitDate.localeCompare(a.visitDate))
                .map((r) => (
                  <li key={r.id} className="px-4 py-3">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm text-gray-800">{r.department ?? '未记录科室'}</span>
                      <span className="ml-auto shrink-0 text-xs tabular-nums text-gray-400">
                        {shortDate(r.visitDate)}
                      </span>
                    </div>
                    {r.diagnosisBrief ? (
                      <p className="mt-1 text-xs leading-relaxed text-gray-600">
                        {r.diagnosisBrief}
                      </p>
                    ) : null}
                    {r.ocrText ? (
                      <p className="mt-1 text-xs leading-relaxed text-gray-400">{r.ocrText}</p>
                    ) : null}
                  </li>
                ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2 text-sm font-medium text-gray-700">{children}</h2>;
}

function PrivacyNote() {
  return (
    <div className="rounded-xl bg-gray-100 p-4">
      <p className="text-xs leading-relaxed text-gray-600">
        <strong className="font-medium text-gray-800">这些数据在哪儿：</strong>
        病历原文只存在你这台设备的浏览器里，上传到服务端的只有脱敏后的摘要。
        我们的数据库里连存原文的字段都没有。
      </p>
    </div>
  );
}
