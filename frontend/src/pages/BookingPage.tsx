/* ------------------------------------------------------------------
 * 挂号 —— 不经过对话，直接选院区、科室、日期、时段下单
 *
 * ============ 为什么对话里已经有预约卡，还要做这一页 ============
 *
 * 对话里的预约卡是「AI 帮你选好了，你确认」。它的问题是**没有选择权**：
 *   · 想换个时段 → 没法选，只能接受给的第一个
 *   · 想看看这周哪天有号 → 卡片只显示一天
 *   · 想换个科室 → 只能在分诊给的几个方向里挑，换不到别的
 *
 * 真实挂号场景里，"我自己看看有没有号"是高频动作，不是每次都要
 * 先讲一遍症状。所以这一页做的是**手动挂号**，和对话那条路并行：
 *   · 对话：不确定挂哪个科 → 让 AI 判断 → 它顺手给个号
 *   · 这一页：已经知道要挂什么 → 直接选 → 挑时段
 *
 * 从对话跳进来时，科室范围收窄成"分诊推荐的那几个"（见下方
 * recommended）；直接打开这一页时，按院区自由选科。
 *
 * ============ 三条硬约束 ============
 *
 * 1. **号源必须实时查后端**，不能在本地缓存一份假的可约时段。
 *    院方号表是别人的数据，缓存下来的结果会让患者点进去才发现没号。
 *
 * 2. **没有号就明说，不给"可能还有"**。
 *    科室没排班 / 当天已过时 / 号已满，三种情况文案不同 ——
 *    患者该做的事完全不同（换日期 / 明天再来 / 换医院）。
 *
 * 3. **下单前必须二次确认**。占号是不可回滚的操作，
 *    误点一次就占掉一个号，还会让真正要看病的人约不到。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionTitle } from '../components/ui/SectionTitle';
import {
  createBooking,
  ensureLogin,
  getSlots,
  loadHospitalCatalog,
  type BackendFailure,
  type HospitalCatalogEntry,
  type SlotItem,
} from '../lib/api';

/** 往后可选的日期天数。14 天是多数医院的放号周期 */
const DAYS = 14;

/** YYYY-MM-DD，**本地时区**。用 toISOString 会在凌晨退到前一天 */
function toDateStr(d: Date): string {
  return d.toLocaleDateString('sv-SE');
}

/** 从今天起算的 N 天 */
function nextDays(n: number): string[] {
  const out: string[] = [];
  const base = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    out.push(toDateStr(d));
  }
  return out;
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** 「11-17」+「周二」 */
function shortDateAndWeek(dateStr: string): { md: string; week: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y!, (m ?? 1) - 1, d!);
  return { md: `${m}-${d}`, week: `周${WEEKDAY[dt.getDay()]}` };
}

export default function BookingPage() {
  /*
   * 从对话卡「去挂号」带过来的参数：院区 / 科室 / 日期 / 时段 / 推荐科室表。
   *
   * 科室的边界是**推荐范围**，不是单点锁定：分诊本来就会给两三个方向
   * （首选 62%、次选 50%…），患者在这几个之间挑一个完全合理。
   * 所以这里允许切换，但只在 `departments` 给的那几个科里切 ——
   * 换成推荐之外的科，就等于绕过了整个分诊，问诊结论也就白算了。
   */
  const [searchParams] = useSearchParams();
  const recommended = useMemo(
    () =>
      (searchParams.get('departments') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    [searchParams],
  );
  const wantedDepartment = (searchParams.get('department') ?? '').trim();
  const wantedHospital = (searchParams.get('hospital') ?? '').trim();
  const wantedSlot = (searchParams.get('slot') ?? '').trim();

  const [catalog, setCatalog] = useState<HospitalCatalogEntry[]>([]);
  const [hospitalCode, setHospitalCode] = useState('');

  // 进来的那一刻：优先用指定科室，其次推荐首选，最后等目录加载后落第一个
  const [department, setDepartment] = useState(wantedDepartment || recommended[0] || '');
  const [date, setDate] = useState(() => {
    const d = (searchParams.get('date') ?? '').trim();
    // 只接受 YYYY-MM-DD，其余（含过去日期）一律回到今天
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : toDateStr(new Date());
  });

  const [slots, setSlots] = useState<SlotItem[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);

  const [selected, setSelected] = useState<SlotItem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const [bootError, setBootError] = useState<BackendFailure | null>(null);
  /** 目录加载完（成功或失败）都置 true，用来区分"还在加载"和"确实没有可约院区" */
  const [catalogReady, setCatalogReady] = useState(false);

  const days = useMemo(() => nextDays(DAYS), []);

  /* ---------- 初始化：院区目录 ---------- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await loadHospitalCatalog();
      if (cancelled) return;
      setCatalogReady(true);
      if (!r.ok) {
        setBootError(r.failure);
        return;
      }
      setCatalog(r.data);

      /*
       * 选初始院区：对话指定的那家优先，但它得**真的开了这个科**；
       * 否则退到第一家开这个科的，再不行才退到第一家。
       * 不这么挑的话，用户会落进一个没这个科的院区，看到"没放号"。
       */
      const offers = (h: HospitalCatalogEntry) =>
        !department || h.departments.includes(department);
      const pick =
        r.data.find((h) => h.code === wantedHospital && offers(h)) ??
        r.data.find(offers) ??
        r.data[0];
      if (pick) {
        setHospitalCode(pick.code);
        if (!department) setDepartment(pick.departments[0] ?? '');
      }
    })();
    return () => {
      cancelled = true;
    };
    // 参数来自地址栏，进页面后不会再变；只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = catalog.find((h) => h.code === hospitalCode);

  /*
   * 可选院区。
   *
   * 有推荐科室时：**按当前科室过滤**，只列开了这个科的院区 ——
   * 换科室会让院区列表跟着变，这样"心血管内科 → 滨江"这种组合
   * 永远是真实存在的。
   * 没有推荐科室时（用户直接进挂号页）：全部院区，科室反过来跟着院区走。
   */
  const visibleHospitals = useMemo(() => {
    if (recommended.length === 0) return catalog;
    return catalog.filter((h) => h.departments.includes(department));
  }, [recommended.length, catalog, department]);

  /* ---------- 院区必须落在可见列表里 ---------- */
  useEffect(() => {
    if (visibleHospitals.length === 0) return;
    if (!visibleHospitals.some((h) => h.code === hospitalCode)) {
      setHospitalCode(visibleHospitals[0]!.code);
    }
  }, [visibleHospitals, hospitalCode]);

  /* ---------- 没有推荐时：科室跟着院区走（原有行为） ---------- */
  useEffect(() => {
    if (recommended.length > 0 || !current) return;
    // 原来选的科室在新院区没有 → 落到第一个，避免查一个不存在的科
    if (!current.departments.includes(department)) {
      setDepartment(current.departments[0] ?? '');
    }
  }, [recommended.length, current, department]);

  /* ---------- 有推荐时：科室必须落在推荐范围内 ---------- */
  useEffect(() => {
    if (recommended.length === 0 || catalog.length === 0) return;
    const allowed = recommended.filter((d) =>
      catalog.some((h) => h.departments.includes(d)),
    );
    if (allowed.length === 0) {
      // 推荐里没有一个科真的可约 —— 交给下面的空态说明，不要乱选
      if (department) setDepartment('');
      return;
    }
    if (!allowed.includes(department)) setDepartment(allowed[0]!);
  }, [recommended, catalog, department]);

  /* ---------- 查号源 ---------- */
  const loadSlots = useCallback(
    async (opts?: { keepSelection?: boolean }) => {
      if (!hospitalCode || !department || !date) return;
      setLoadingSlots(true);
      setSlotsError(null);
      /*
       * 正常情况下换日期/科室时要清掉已选时段 —— 旧的时段在新查询里
       * 可能根本不存在了。但**下单成功后不能清**：成功提示就挂在
       * selected 下面，一清就把「已挂上几点」这句话连同按钮一起抹掉，
       * 患者看到的是"我点了确认，然后卡片消失了"。
       */
      if (!opts?.keepSelection) setSelected(null);

      const r = await getSlots({ hospitalCode, department, date });
      setLoadingSlots(false);

      if (!r.ok) {
        setSlots([]);
        setSlotsError(
          r.failure.kind === 'unreachable'
            ? '号源服务连不上，请确认后端已启动。'
            : r.failure.kind === 'unauthorized'
              ? '登录已失效，请刷新页面重试。'
              : '号源查询失败，请稍后重试。',
        );
        return;
      }
      setSlots(r.data);
    },
    [hospitalCode, department, date],
  );

  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  /*
   * 预选对话里给的那个时段。
   *
   * 只做一次（preselected 守卫）：之后用户自己换日期/时段，
   * 不能被这个 effect 又拽回去。余量为 0 时也不选 ——
   * 给一个"选中了但点不了"的状态比不选更让人困惑。
   */
  const [preselected, setPreselected] = useState(false);
  useEffect(() => {
    if (preselected || !wantedSlot || slots.length === 0) return;
    const hit = slots.find((s) => s.visitTime === wantedSlot && s.remaining > 0);
    if (hit) setSelected(hit);
    setPreselected(true);
  }, [slots, wantedSlot, preselected]);

  /* ---------- 下单 ---------- */
  const confirm = async () => {
    if (!selected || !current) return;
    setSubmitting(true);
    setResult(null);

    /*
     * 下单需要登录。这里显式 ensureLogin 而不是依赖 401 重试：
     * 挂号是要记到人身上的，静默失败比慢一点难查得多。
     */
    const auth = await ensureLogin();
    if (!auth.ok) {
      setSubmitting(false);
      setResult({ ok: false, text: '登录失败，无法挂号。请刷新页面重试。' });
      return;
    }

    const r = await createBooking({
      hospitalCode,
      department,
      visitTime: selected.visitTime,
    });
    setSubmitting(false);

    if (r.ok) {
      setResult({
        ok: true,
        text: `已挂上 ${shortDateAndWeek(date).md} ${selected.visitTime.slice(11, 16)} 的号，可以在「我的病历」或「到院」查看。`,
      });
      // 重新拉一次号源：这个时段余量可能刚好变成 0。
      // keepSelection 保住成功提示 —— 否则点完确认卡片就消失了。
      void loadSlots({ keepSelection: true });
    } else {
      setResult({
        ok: false,
        // 号满 / 该时段不存在，后端给的原因比我们猜的准，原样透传
        text:
          r.failure.kind === 'unreachable'
            ? '挂号服务连不上，请到医院自助机或窗口办理。'
            : 'message' in r.failure
              ? r.failure.message
              : '挂号失败，请稍后重试。',
      });
    }
  };

  if (bootError) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="text-sm font-medium text-amber-900">读不到院区信息</div>
        <p className="mt-1 text-xs leading-relaxed text-amber-800">
          {bootError.kind === 'unreachable'
            ? '后端未启动。在 backend 目录执行 mvn spring-boot:run 后再试。'
            : '请稍后重试。'}
        </p>
      </div>
    );
  }

  /*
   * 推荐的科室一个都约不上（目录里就没开）—— 必须说清楚"不是你挂号点错了，
   * 是这个科这段时间不开线上号"，否则用户会以为自己在瞎点。
   */
  if (catalogReady && recommended.length > 0 && visibleHospitals.length === 0) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="text-sm font-medium text-amber-900">
          推荐的{recommended.map((d) => `「${d}」`).join('、')}暂时没有可预约的院区
        </div>
        <p className="mt-1 text-xs leading-relaxed text-amber-800">
          这段时间线上没有放这些科的号，可以到院自助机或窗口办理，也可以
          <Link to="/chat" className="mx-1 text-brand-700 underline">
            回问诊
          </Link>
          重新描述一下症状，让分诊再判断一次。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="挂号"
        subtitle={
          recommended.length > 0 ? (
            <>
              科室按问诊推荐给出（首选「{wantedDepartment || recommended[0]}」），可以在这几个科之间换。
              要换到别的科，请
              <Link to="/chat" className="mx-1 text-brand-700 underline">
                回问诊
              </Link>
              重新描述症状。
            </>
          ) : (
            <>
              自己选院区和时段。不确定该挂哪个科，可以先去
              <Link to="/chat" className="mx-1 text-brand-700 underline">
                问诊
              </Link>
              ，让 AI 帮你判断。
            </>
          )
        }
      />

      {/* ---------- 院区 ---------- */}
      <Section title="选院区">
        <div className="grid gap-2">
          {visibleHospitals.map((h) => {
            const active = h.code === hospitalCode;
            return (
              <button
                key={h.code}
                type="button"
                onClick={() => setHospitalCode(h.code)}
                className={
                  'rounded-xl border p-3 text-left transition-colors ' +
                  (active
                    ? 'border-brand-400 bg-brand-50/50'
                    : 'border-gray-200 bg-surface hover:border-gray-300')
                }
              >
                <div className="text-sm font-medium text-gray-900">{h.name}</div>
                <div className="mt-0.5 text-xs text-gray-500">
                  {h.departments.length} 个科室可约
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      {/* ---------- 科室 ---------- */}
      <Section title={recommended.length > 0 ? '选科室（问诊推荐）' : '选科室'}>
        {/*
          有推荐：只列推荐的几个科，可以在这几个里切换。
          没有推荐（用户直接进这一页）：列当前院区的全部科室。

          为什么推荐之外不给选项：分诊已经给过方向了，在这里随手换成
          一个没被推荐过的科，等于把问诊结论丢掉重来 —— 而且要换到
          别的科，本来就该回问诊再描述一次，那样分诊会重新判断。
        */}
        {recommended.length > 0 ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {recommended.map((d) => {
                // 目录里没有这个科 → 给一个不可点的按钮，并说明原因。
                // 直接藏起来会让用户以为推荐错了。
                const available = catalog.some((h) => h.departments.includes(d));
                const active = d === department;
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={!available}
                    onClick={() => setDepartment(d)}
                    className={
                      'rounded-lg border px-3 py-1.5 text-sm transition-colors ' +
                      (!available
                        ? 'cursor-not-allowed border-gray-100 bg-gray-50 text-gray-300'
                        : active
                          ? 'border-brand-500 bg-action text-white'
                          : 'border-gray-200 bg-surface text-gray-700 hover:border-gray-300')
                    }
                  >
                    {d}
                    {!available ? <span className="ml-1 text-2xs">暂不可约</span> : null}
                  </button>
                );
              })}
            </div>
            <p className="text-xs leading-relaxed text-gray-400">
              这几个科是问诊给出的方向，在这里换科室不会影响判断；要挂推荐之外的科，请回问诊重新描述症状。
            </p>
          </div>
        ) : current && current.departments.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {current.departments.map((d) => {
              const active = d === department;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDepartment(d)}
                  className={
                    'rounded-lg border px-3 py-1.5 text-sm transition-colors ' +
                    (active
                      ? 'border-brand-500 bg-action text-white'
                      : 'border-gray-200 bg-surface text-gray-700 hover:border-gray-300')
                  }
                >
                  {d}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-gray-400">这个院区还没有配置可约科室。</p>
        )}
      </Section>

      {/* ---------- 日期 ---------- */}
      <Section title="选日期">
        {/*
          横向滚动的日期条而不是下拉框：
          挂号时患者是在"扫一眼哪天有号"，下拉框要点开、看、再点，
          而横条一次能扫到十天，没号的那天一眼就看出来。
        */}
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {days.map((d) => {
            const active = d === date;
            const { md, week } = shortDateAndWeek(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDate(d)}
                className={
                  'flex min-w-[62px] shrink-0 flex-col items-center rounded-lg border px-2 py-1.5 text-xs transition-colors ' +
                  (active
                    ? 'border-brand-500 bg-action text-white'
                    : 'border-gray-200 bg-surface text-gray-600 hover:border-gray-300')
                }
              >
                <span className="font-medium tabular-nums">{md}</span>
                <span className={active ? 'text-white/80' : 'text-gray-400'}>{week}</span>
              </button>
            );
          })}
        </div>
      </Section>

      {/* ---------- 号源 ---------- */}
      <Section title="选时段">
        {loadingSlots ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-11 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        ) : slotsError ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {slotsError}
          </p>
        ) : slots.length === 0 ? (
          <NoSlots date={date} today={toDateStr(new Date())} />
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {slots.map((s) => {
              const full = s.remaining <= 0;
              const active = selected?.visitTime === s.visitTime;
              return (
                <button
                  key={s.visitTime}
                  type="button"
                  disabled={full}
                  onClick={() => setSelected(active ? null : s)}
                  className={
                    'rounded-lg border px-2 py-2 text-center transition-colors ' +
                    (full
                      ? 'cursor-not-allowed border-gray-100 bg-gray-50 text-gray-300'
                      : active
                        ? 'border-brand-500 bg-action text-white'
                        : 'border-gray-200 bg-surface text-gray-700 hover:border-brand-300')
                  }
                >
                  <div className="text-sm font-medium tabular-nums">{s.visitTime.slice(11, 16)}</div>
                  <div
                    className={
                      'mt-0.5 truncate text-2xs ' +
                      (full ? 'text-gray-300' : active ? 'text-white/80' : 'text-gray-400')
                    }
                  >
                    {full ? '已满' : `${s.doctorName.split(' · ').pop() ?? s.doctorName} · 余 ${s.remaining}`}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      {/* ---------- 确认 ---------- */}
      {selected ? (
        <section className="rounded-xl border border-brand-200 bg-surface p-4">
          <h2 className="text-sm font-medium text-gray-700">确认挂号信息</h2>
          <dl className="mt-2 space-y-1.5 text-sm">
            <Row label="院区" value={current?.name ?? hospitalCode} />
            <Row label="科室" value={department} />
            <Row
              label="时间"
              value={`${shortDateAndWeek(date).md} ${shortDateAndWeek(date).week} ${selected.visitTime.slice(11, 16)}`}
            />
            <Row label="医生" value={selected.doctorName} />
          </dl>

          {result ? (
            <p
              className={
                'mt-3 rounded-lg px-3 py-2 text-xs leading-relaxed ' +
                (result.ok ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-800')
              }
            >
              {result.text}
            </p>
          ) : null}

          {result?.ok ? (
            <div className="mt-3 flex gap-2">
              <Link
                to="/visit"
                className="rounded-lg bg-action px-3 py-1.5 text-xs font-medium text-white"
              >
                到院后看怎么走 →
              </Link>
              <Link
                to="/records"
                className="rounded-lg border border-gray-200 bg-surface px-3 py-1.5 text-xs text-gray-700"
              >
                我的预约
              </Link>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={submitting}
                className="h-9 rounded-lg bg-action px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {submitting ? '正在挂号…' : '确认挂号'}
              </button>
              <span className="text-xs leading-relaxed text-gray-400">
                确认后会占用该号源，请确定时间合适再点
              </span>
            </div>
          )}
        </section>
      ) : null}

      <p className="text-xs leading-relaxed text-gray-400">
        号源来自院区适配器，为演示数据。真实接入需院方开通接口（见接口清单）。
      </p>
    </div>
  );
}

/* ============================ 小组件 ============================ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-10 shrink-0 text-gray-400">{label}</dt>
      <dd className="text-gray-800">{value}</dd>
    </div>
  );
}

/**
 * 没号时的三种说法。
 *
 * <p>必须分开：选的是过去的日期（不该来）、当天但时段都过了（明天再来）、
 * 这天确实没放号（换一天）。合成一句「暂无可预约号源」，
 * 患者不知道该做什么。
 */
function NoSlots({ date, today }: { date: string; today: string }) {
  const isPast = date < today;
  const isToday = date === today;

  return (
    <div className="rounded-lg border border-gray-200 bg-surface px-3 py-3">
      <p className="text-sm text-gray-700">
        {isPast
          ? '这一天已经过去了，选今天或之后的日期。'
          : isToday
            ? '今天这个科室的号已经放完了或时段都过了，可以选明天以后。'
            : '这一天这个科室没有放号，换个日期看看。'}
      </p>
      <p className="mt-1 text-xs leading-relaxed text-gray-400">
        号源是院方实时数据，我们不做预留。
      </p>
    </div>
  );
}
