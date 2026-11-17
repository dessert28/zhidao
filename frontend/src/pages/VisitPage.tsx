/* ------------------------------------------------------------------
 * 到院 —— 患者站在门诊楼里的那一屏
 *
 * ============ 为什么要单独一页 ============
 *
 * 院内导航、排队估算、取药流程这三样原本埋在别处：
 *   · 导航只在「确认挂号成功」那一下展开，刷新或离开就没了
 *   · 排队估算挂在「我的病历」的预约列表里面，要滚很久才看得到
 *   · 取药只有导航步骤里一句「先缴费再取药」
 *
 * 而它们的使用场景是同一个：**人已经在医院里了，一手拿手机一手拿挂号单**。
 * 这个时刻最需要的是「我现在去哪、还要等多久、药在哪拿」，
 * 不是病历时间轴，也不是聊天框。所以单独占一屏，进来先看到那张卡。
 *
 * ============ 和「今日」页的分工 ============
 *
 * 「今日」管的是**还没到医院之前**：今天该吃什么药、哪天该复查。
 * 这一页只管**进了医院之后**。两页不重叠，手机上各占一个 tab。
 *
 * ============ 没有预约时怎么办 ============
 *
 * 不显示空页面，也不假装有数据。明确说「今天没有进行中的预约」，
 * 并把去问诊/约号的入口摆出来 —— 一个空白的页面比一句提示更让人迷惑。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  clearToken,
  ensureLogin,
  getBookings,
  getNavRoute,
  getQueueEstimate,
  getVisitProgress,
  hospitalName,
  loadHospitalCatalog,
  markVisitStep,
  navKeyOf,
  type BackendFailure,
  type BookingOrder,
  type NavRoute,
  type QueueInfo,
  type StepState,
} from '../lib/api';
import { CheckInCard } from '../components/CheckInCard';
import { ExamOrderCard, toParsedExams } from '../components/ExamOrderCard';
import { latestExamOrder, type LocalRecord } from '../lib/db/records';
import { planExamSequence, type PlannedStep } from '../lib/exam/sequence';

interface VisitState {
  loading: boolean;
  failure: BackendFailure | null;
  /** 当前该关注的那一单。null = 没有进行中的预约 */
  order: BookingOrder | null;
}

export default function VisitPage() {
  const [state, setState] = useState<VisitState>({
    loading: true,
    failure: null,
    order: null,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await fetchBookingsWithRelogin();
      if (cancelled) return;
      if (!r.ok) {
        setState({ loading: false, failure: r.failure, order: null });
        return;
      }

      /*
       * 先把院区目录拉下来再决定展示什么。
       *
       * <p>不拉的话 {@code hospitalName()} 手里没有映射表，会退化成
       * 直接显示 "Z2-JFL" —— 内部编码出现在患者界面上，比显示
       * 一个不准确的医院名更糟。这一页第一次跑起来时就是这个症状。
       *
       * <p>失败不阻塞：目录挂了仍然可以显示导航，只是名字难看。
       */
      await loadHospitalCatalog();
      if (cancelled) return;
      /*
       * 挑"最该关注"的那一单。
       *
       * 排序规则刻意用「就诊时间最早且还没过」而不是「最近创建」：
       * 患者可能同时有下周复查和今天看诊两单，进来该看到的是今天的那单。
       * 已取消的、已经过去很久的不算。
       */
      const now = Date.now();
      const active = r.data
        .filter((o) => o.status !== 'CANCELLED')
        .filter((o) => new Date(o.visitTime).getTime() > now - 12 * 3600_000)
        .sort((a, b) => a.visitTime.localeCompare(b.visitTime));

      setState({ loading: false, failure: null, order: active[0] ?? null });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.loading) {
    return (
      <div className="space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="h-32 animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
    );
  }

  if (state.failure) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="text-sm font-medium text-amber-900">暂时读不到你的预约</div>
        <p className="mt-1 text-xs leading-relaxed text-amber-800">
          {state.failure.kind === 'unreachable'
            ? '后端未启动。在 backend 目录执行 mvn spring-boot:run 后再试。'
            : state.failure.kind === 'unauthorized'
              ? '登录已失效，请重试。'
              : 'disabled' in state.failure
                ? state.failure.message
                : '读不到预约数据，请稍后重试。'}
        </p>
      </div>
    );
  }

  if (!state.order) {
    return (
      <div className="flex flex-col items-center py-16 text-center">
        <h1 className="text-lg font-semibold text-gray-900">今天没有进行中的预约</h1>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-gray-500">
          这一页是给"人已经在医院里"准备的：找到科室、看还要等多久、药在哪拿。
          有预约之后再来。
        </p>
        <div className="mt-5 flex gap-2">
          <Link
            to="/chat"
            className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white"
          >
            去问诊约号
          </Link>
          <Link
            to="/records"
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm text-gray-700"
          >
            看看全部预约
          </Link>
        </div>
      </div>
    );
  }

  return <VisitDetail order={state.order} />;
}

/* ============================ 主内容 ============================ */

/**
 * 取预约列表，token 失效时自动重登一次。
 *
 * <p><b>为什么必须有这一层</b>：{@code ensureLogin()} 只要本地有 token
 * 就直接返回成功 —— 它不验证这个 token 还有效。而后端重启时
 * JWT 密钥会重新生成，浏览器里所有旧 token 立刻作废。
 * 表现就是这一页打开只显示「登录已失效，请重试」，而用户
 * 没有任何"重试"的入口 —— 他只能困惑地刷新，刷完还是那样。
 *
 * <p>这个场景在演示时特别容易撞上：改完后端代码重启一次，
 * 浏览器里的旧 token 就废了。
 *
 * <p>只重试一次：如果重登之后仍然 401，那是别的问题（比如账号被禁），
 * 无限重试只会掩盖它。
 */
async function fetchBookingsWithRelogin(): Promise<
  | { ok: true; data: BookingOrder[] }
  | { ok: false; failure: BackendFailure }
> {
  const auth = await ensureLogin();
  if (!auth.ok) return { ok: false, failure: auth.failure };

  let r = await getBookings();
  if (!r.ok && r.failure.kind === 'unauthorized') {
    // 清掉失效 token，逼 ensureLogin 重新登录
    clearToken();
    const re = await ensureLogin();
    if (re.ok) r = await getBookings();
  }
  return r;
}

function VisitDetail({ order: initialOrder }: { order: BookingOrder }) {
  /**
   * 签到会更新这张单（多一个 checkinAt），但父组件拿的是初始快照。
   *
   * <p>用本地 state 接住更新，而不是让父组件重新拉一遍列表：
   * 重新拉会触发整页 loading 闪烁，而患者只是点了一下签到 ——
   * 不该把已经看到的导航和排队信息闪掉重来。
   */
  const [order, setOrder] = useState<BookingOrder>(initialOrder);

  const [route, setRoute] = useState<NavRoute | null>(null);
  const [queue, setQueue] = useState<QueueInfo | null>(null);
  const [navError, setNavError] = useState<string | null>(null);

  /**
   * 患者手动标记的进度（navKey → DONE/SKIPPED）。
   *
   * <p>单独存一份而不是只依赖 route.steps 里的 status：
   * 标记完成后要立刻重拉路线（让 CURRENT 顺延），重拉是异步的；
   * 有一个本地副本，按钮的"处理中"状态和"已标记几步"的计数
   * 才能立即反映，不会出现点了没反应的一瞬。
   */
  const [marks, setMarks] = useState<Record<string, StepState>>({});
  /** 正在提交的 navKey，用于禁用按钮防连点 */
  const [marking, setMarking] = useState<string | null>(null);

  /**
   * 患者上传的检查单（如果有）。
   *
   * <p>**这是"医生说做什么"的唯一来源**。没有它，指引只能按科室
   * 猜一个通用流程；有了它，才知道这次到底要拍片还是抽血、
   * 要不要空腹 —— 而这些只有检查单上写着。
   *
   * <p>从 IndexedDB 读，不联网：检查单原文本来就在本地。
   */
  const [examOrder, setExamOrder] = useState<LocalRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await latestExamOrder(order.hospitalCode);
      if (!cancelled) setExamOrder(found ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [order.hospitalCode]);

  /*
   * 空不空腹决定检查排在第几步，来源有两个，优先级如下：
   *
   *   1. **检查单上写了** —— 这是医生开的，最准
   *   2. 没有检查单时，按科室推断（内分泌/消化常要空腹）
   *
   * 之前只有第 2 条路。患者上传了检查单却仍按科室猜，
   * 会出现"检查单明明写了无需空腹，系统还是按空腹排"的情况。
   */
  const needsFasting = useMemo(() => {
    if (examOrder?.examItems && examOrder.examItems.length > 0) {
      return examOrder.examItems.some((e) => e.fasting === true);
    }
    return /内分泌|消化/.test(order.department);
  }, [examOrder, order.department]);

  const load = useCallback(async () => {
    const [nav, q, pg] = await Promise.all([
      getNavRoute({
        hospitalCode: order.hospitalCode,
        department: order.department,
        needsFasting,
        visitTime: order.visitTime,
        // 带上 bookingId，后端才会把这一单的手动进度叠加进来
        bookingId: order.id,
      }),
      getQueueEstimate(order.id),
      // 进度与路线并行拉：串行会让"现在去哪"多等一个往返
      getVisitProgress(order.id),
    ]);

    if (nav.ok) {
      setRoute(nav.data);
      setNavError(null);
    } else {
      setNavError(
        nav.failure.kind === 'unreachable'
          ? '院内导航服务未启动'
          : 'message' in nav.failure
            ? nav.failure.message
            : '暂时拿不到院内路线。',
      );
    }
    // 排队估算失败不是致命问题：导航仍然可用，所以只吞掉这一块
    if (q.ok) setQueue(q.data);
    // 进度读不到就按空处理，路线自己还有时间推算的默认值
    if (pg.ok) setMarks(pg.data);
  }, [order.hospitalCode, order.department, order.visitTime, order.id, needsFasting]);

  /**
   * 标记某一步，然后立刻重拉路线。
   *
   * <p>为什么必须重拉而不是本地改 status：
   * CURRENT 的顺延是后端按"第一个没被标记的步骤"算的，
   * 本地只改自己那一步，会出现"第 1 步完成了但第 2 步还不是当前"。
   */
  const handleMark = useCallback(
    async (navKey: string, state: StepState | '') => {
      setMarking(navKey);
      /*
       * 记住滚动位置。
       *
       * <p>标记完成后要重拉路线（CURRENT 的顺延由后端算），
       * 但重拉会让页面高度变化，浏览器把滚动位置顶回顶部 ——
       * 实测表现是"点了第 3 步做完了，页面跳回最上面"，
       * 患者还得再滚下来找自己刚才那一步。在手机上这会非常恼人。
       *
       * <p><b>为什么用两次 rAF 而不是一次</b>：一次 rAF 只保证
       * "下一帧前"，而 React 的 setState → 重新渲染 → 浏览器重排
       * 要跨越那一帧；在第一帧前设回 scrollTop，随后重排又把它冲掉。
       * 两次 rAF 跨过一个完整的样式计算+布局周期，实测才稳。
       */
      const scrollY = window.scrollY;
      const r = await markVisitStep(order.id, navKey, state);
      if (r.ok) {
        setMarks(r.data.progress);
        await load();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => window.scrollTo({ top: scrollY }));
        });
      }
      setMarking(null);
    },
    [order.id, load],
  );

  useEffect(() => {
    void load();
    /*
     * 每 2 分钟刷新。理由与 HospitalNav 相同：状态只在跨过某一步的
     * 建议时间时才变，更密的轮询只是无谓请求。
     */
    const timer = setInterval(() => void load(), 120_000);
    return () => clearInterval(timer);
  }, [load]);

  const current = route?.steps.find((s) => s.status === 'CURRENT');

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-gray-900">到院</h1>
        <p className="mt-1.5 text-sm text-gray-500">
          {hospitalName(order.hospitalCode)} · {order.department} ·{' '}
          {order.visitTime.slice(5, 10)} {order.visitTime.slice(11, 16)}
        </p>
      </header>

      {/*
        签到排在「现在去哪」之前。
        患者推门进来的第一件事是"我到了，然后呢"，
        没签到就看导航，他会以为系统已经知道他到了。
      */}
      <CheckInCard order={order} onCheckedIn={setOrder} />

      {/*
        第一块永远是「现在去哪」。
        患者站在大厅里打开这一页，唯一想知道的就是下一步往哪走；
        放在最上面、字号最大，其余信息都排在它后面。
      */}
      <section className="rounded-xl border-2 border-brand-500 bg-brand-50 p-4">
        <div className="text-xs font-medium text-brand-700">现在去这里</div>
        {current ? (
          <>
            <div className="mt-1.5 text-lg font-semibold text-gray-900">{current.place.name}</div>
            <div className="mt-0.5 text-sm text-gray-700">
              {current.place.building} {current.place.floor}
              {current.place.directions ? ` · ${current.place.directions}` : ''}
            </div>
            {current.note ? (
              <p className="mt-1.5 text-xs leading-relaxed text-gray-600">{current.note}</p>
            ) : null}
          </>
        ) : (
          <p className="mt-1.5 text-sm text-gray-600">
            {navError ?? '按下面的步骤走，每一步到了会自动跳到下一步。'}
          </p>
        )}
      </section>

      {/*
        检查单紧跟在「现在去这里」之后。
        患者看完"现在去哪"，下一个问题就是"医生让我做哪些检查"，
        而检查项目又反过来影响了上面那条路线 —— 两者要挨着看。
      */}
      <ExamOrderCard record={examOrder} />

      {/* 检查建议顺序：补充"这几项谁先做"，不改动下面由后端算出的路线 */}
      <ExamSequenceHint record={examOrder} />

      {/* 排队：紧跟在"现在去哪"后面 —— 知道去哪之后，下一个问题就是"要等多久" */}
      {queue ? <QueueBlock queue={queue} /> : null}

      {route && route.steps.length > 0 ? (
        <StepsBlock route={route} marks={marks} onMark={handleMark} marking={marking} />
      ) : !navError ? (
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-400">
          这个院区还没有配置院内导航，可以到一楼服务台问路。
        </div>
      ) : null}

      <PharmacyNote hospitalCode={order.hospitalCode} />

      {/*
        ============ 离开医院之后 ============
        原页面到"取药"就结束了，但患者的流程还没完：
        报告没出全、下次复查在什么时候、这次的记录要不要传上来。
        这三件事如果这一页不提，患者出了门就得自己想 ——
        而"下次复查"恰恰是这个系统存在的意义之一。

        刻意做成纯文字指引而不是自动任务：
        我们不知道医生到底开了什么检查，也不知道报告什么时候出。
        给一个具体时间点就是在编。
      */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-medium text-gray-700">看完之后</h2>
        <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-gray-700">
          <li>
            <span className="text-gray-500">报告：</span>
            部分检查当天出不了结果，留意短信或关注医院公众号的推送。结果出来后在
            <Link to="/records" className="mx-1 text-brand-700 underline">
              我的病历
            </Link>
            上传，我才能在下一次就诊前帮你比对。
          </li>
          <li>
            <span className="text-gray-500">用药：</span>
            取药时药师交代的用法比药盒上的更准。如果这次医生调整了用药，
            建议在
            <Link to="/health" className="mx-1 text-brand-700 underline">
              健康管家
            </Link>
            更新一下，之后的提醒才跟得上。
          </li>
          <li>
            <span className="text-gray-500">复查：</span>
            医生如果说了"三个月后复查"，告诉我一声，我会在那之前提醒你。
          </li>
        </ul>
      </section>

      {/* 演示标注必须显眼：示意楼层被当成真实导航，比不做导航更糟 */}
      {route?.dataQuality === 'SAMPLE' ? (
        <p className="text-xs leading-relaxed text-gray-400">
          楼层与诊区为示意数据（三甲医院通用布局），不是该院实时导航。到院后请以现场指示牌为准。
        </p>
      ) : null}
    </div>
  );
}

/* ============================ 检查建议顺序 ============================ */

/**
 * 检查建议顺序 —— 对后端院内路线的补充说明。
 *
 * <p><b>为什么不并进后端路线</b>：后端路线是按科室和 stage 推出来的站点，
 * 它不知道医生这次开了哪几项、哪项要空腹。要并进去就得改 route 的数据结构
 * 与后端排程，而顺序规划本身只是前端的一条流程规则。所以这里只补一句
 * "这几项谁先做"，站点、楼层、时间仍完全由后端决定 —— 两者不打架。
 *
 * <p>只有一项检查时不显示：一项检查没有"谁先谁后"，多一块文字
 * 只会稀释上面那条"现在去这里"。
 */
function ExamSequenceHint({ record }: { record: LocalRecord | null }) {
  const steps = useMemo<PlannedStep[]>(() => {
    const items = record?.examItems;
    if (!items || items.length === 0) return [];
    return planExamSequence(toParsedExams(items));
  }, [record]);

  if (steps.length < 2) return null;

  const unknown = steps.filter((s) => s.needsConfirmation).map((s) => s.exam.name);

  return (
    <section className="rounded-xl border border-brand-100 bg-brand-50/50 px-3 py-2.5">
      <div className="text-xs font-medium text-brand-800">检查建议顺序</div>
      <p className="mt-1 text-sm leading-relaxed text-gray-800">
        {steps.map((s) => `${s.order}. ${s.exam.name}`).join(' → ')}
      </p>
      {unknown.length > 0 ? (
        <p className="mt-1 text-xs leading-relaxed text-amber-700">
          {unknown.join('、')} 要不要空腹、怎么排，先问分诊台。
        </p>
      ) : null}
      <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
        这是流程上的先后建议，用来补充下面的到院路线；走哪一层、去哪一站仍以院内路线和现场指示为准。
      </p>
    </section>
  );
}

/* ============================ 排队 ============================ */

function QueueBlock({ queue }: { queue: QueueInfo }) {
  const { estimate } = queue;
  /*
   * 不可靠的估算**不能显示成一个数字**。
   * 「前面还有 0 人」在凌晨查看时是对的，但患者下午到了现场
   * 发现排了十几个人，会认为系统在骗人。所以 low confidence 时
   * 只给原因和建议，不给数字。
   */
  const unreliable = !estimate.reasonable || estimate.confidence === 'LOW';

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-700">还要等多久</h2>
        <span className="text-xs text-gray-400">按每人约 {queue.minutesPerPatient} 分钟估算</span>
      </div>

      {unreliable ? (
        <p className="mt-2 text-sm leading-relaxed text-gray-600">
          {estimate.reason}
        </p>
      ) : (
        <div className="mt-2 flex items-baseline gap-4">
          <div>
            <span className="text-2xl font-semibold tabular-nums text-gray-900">
              {estimate.aheadCount}
            </span>
            <span className="ml-1 text-sm text-gray-500">人前面</span>
          </div>
          <div>
            <span className="text-2xl font-semibold tabular-nums text-gray-900">
              {estimate.waitMinutes}
            </span>
            <span className="ml-1 text-sm text-gray-500">分钟</span>
          </div>
        </div>
      )}

      {estimate.advice ? (
        <p className="mt-2 rounded-lg bg-gray-50 px-3 py-2 text-xs leading-relaxed text-gray-700">
          {estimate.advice}
        </p>
      ) : null}

      {/* disclaimer 必须展示：这是估算，不是院方实时叫号 */}
      <p className="mt-2 text-xs leading-relaxed text-gray-400">{estimate.disclaimer}</p>
    </section>
  );
}

/* ============================ 步骤 ============================ */

/**
 * 分步路线，每一步都能手动标记。
 *
 * <p><b>为什么必须能手动切</b>：原来的状态完全按时间推算，
 * 真实门诊里时间经常不准 —— 抽血排长队、医生临时取消某项检查、
 * 患者中途去缴费。系统说"该去诊区了"，人还站在抽血窗口前。
 * 只有患者自己知道走到哪了，所以每一步都要给一个可操作的入口。
 *
 * <p>三个动作分别对应三种真实情况：
 *   · **做完了** —— 最常见，标 DONE 并让下一步变成"现在去"
 *   · **不用做** —— 医生说这项不用查，标 SKIPPED（不显示成已完成）
 *   · **撤销** —— 标错了，回到系统默认推算
 */
function StepsBlock({
  route,
  marks,
  onMark,
  marking,
}: {
  route: NavRoute;
  marks: Record<string, StepState>;
  onMark: (navKey: string, state: StepState | '') => void;
  /** 正在提交的 navKey，用来禁用重复点击 */
  marking: string | null;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-gray-700">
        到院怎么走
        <span className="ml-2 text-xs font-normal text-gray-400">
          {route.steps.length} 步 · 约 {route.totalMinutes} 分钟
        </span>
        {Object.keys(marks).length > 0 ? (
          <span className="ml-2 text-xs font-normal text-brand-700">
            （已手动标记 {Object.keys(marks).length} 步）
          </span>
        ) : null}
      </h2>

      <ol className="space-y-2">
        {route.steps.map((s, i) => {
          const key = navKeyOf(s);
          const isCurrent = s.status === 'CURRENT';
          const isDone = s.status === 'DONE';
          const isSkipped = s.status === 'SKIPPED';
          const busy = marking === key;
          /* 已经不需要再去的步骤，不再给"完成"按钮 */
          const settled = isDone || isSkipped;

          return (
            <li
              key={key}
              className={
                'rounded-xl border p-3 ' +
                (isCurrent
                  ? 'border-brand-300 bg-brand-50/40 shadow-sm'
                  : settled
                    ? 'border-gray-100 bg-gray-50'
                    : 'border-gray-200 bg-white')
              }
            >
              <div className="flex items-baseline gap-2">
                <span
                  className={
                    'text-sm font-medium ' +
                    (isSkipped
                      ? 'text-gray-400 line-through'
                      : isDone
                        ? 'text-gray-400'
                        : 'text-gray-900')
                  }
                >
                  {i + 1}. {s.place.name}
                </span>
                <span className="text-xs text-gray-400">
                  {s.place.building} {s.place.floor}
                </span>

                {isCurrent ? (
                  <span className="ml-auto rounded bg-brand-700 px-1.5 py-0.5 text-xs text-white">
                    现在去
                  </span>
                ) : isDone ? (
                  <span className="ml-auto text-xs text-gray-400">已完成</span>
                ) : isSkipped ? (
                  <span className="ml-auto text-xs text-gray-400">已跳过</span>
                ) : null}
              </div>

              {s.note ? (
                <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{s.note}</p>
              ) : null}

              {/* 操作区：已结算的只给"撤销"，未结算的给"完成 / 跳过" */}
              <div className="mt-2 flex items-center gap-3">
                {settled ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onMark(key, '')}
                    className="text-xs text-gray-500 underline underline-offset-2 hover:text-gray-800 disabled:opacity-50"
                  >
                    {busy ? '处理中…' : '撤销标记'}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onMark(key, 'DONE')}
                      className={
                        'rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ' +
                        (isCurrent ? 'bg-brand-700 text-white' : 'bg-gray-100 text-gray-700')
                      }
                    >
                      {busy ? '处理中…' : '做完了'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onMark(key, 'SKIPPED')}
                      className="text-xs text-gray-400 underline underline-offset-2 hover:text-gray-600 disabled:opacity-50"
                    >
                      这项不用做
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ============================ 取药 ============================ */

/**
 * 取药窗口这一步，`hospital_place` 的数据里没有单独的类型，
 * 所以这里只给流程说明，不给窗口号。
 *
 * 为什么不硬编一个"3 号窗口"：那个数字一旦和现场不符，
 * 患者会排错队；宁可让他去药房看指示，也不要给一个看起来确定的假答案。
 */
function PharmacyNote({ hospitalCode }: { hospitalCode: string }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-medium text-gray-700">取药</h2>
      <ol className="mt-2 space-y-1.5 text-sm leading-relaxed text-gray-700">
        <li>1. 先完成缴费（自助机、窗口或手机缴费都可以）。</li>
        <li>2. 到门诊药房，凭取药单或医保卡取号。</li>
        <li>3. 听到叫名后到对应窗口取药，药师会交代用法。</li>
      </ol>
      <p className="mt-2 text-xs leading-relaxed text-gray-400">
        {hospitalName(hospitalCode)}的具体取药窗口以现场指示为准。
      </p>
    </section>
  );
}
