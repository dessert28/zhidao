/* ------------------------------------------------------------------
 * 医生工作台 —— 患者授权范围内的就诊资料（只读）
 *
 * ============ 角色判断只是体验层 ============
 *
 * 下面的 currentRole() 只决定「渲染哪一屏」，不构成安全边界：
 * 角色存在 sessionStorage 里，任何人都能改。真正的门禁在后端
 * hasAnyRole("DOCTOR","ADMIN") —— 改前端最多换来一张空列表和一串 403。
 * 保留这一层的唯一理由：患者误点进来时，不该先撞一脸报错。
 *
 * ============ 没有姓名就显示编号 ============
 *
 * displayName 可能为空（手机号注册的用户不填姓名）。
 * 空着不写会被当成加载失败，编一个「张*」更是凭空造事实 ——
 * 医生看到「患者 #12」至少知道这条记录确实没有姓名，
 * 而不是以为自己看错了人。
 *
 * ============ 「未记录」不能写成空白 ============
 *
 * 过敏、慢病、在用药为空时一律显式写「未记录」。
 * 在临床语境里，「没记录」和「确认没有」是两件事：
 * 前者要追问，后者才可以直接开药。留一片空白，等于把前者说成后者。
 *
 * ============ 截断的数据要说清被截断了 ============
 *
 * 详情接口就诊/预约各只取最近 10 条，真实总数在 recordCount/bookingCount。
 * 标题写"最近 N 条 / 共 N 条"，不能让医生把截断结果当成全部病历。
 * 列表同理：后端支持分页，固定取前 50 条却显示真实 total，是自相矛盾。
 *
 * ============ 两栏只在宽屏生效 ============
 *
 * 医生是在诊室里用电脑看这些的：左边挑人、右边看档案，换患者点一下
 * 就行，不用在长页面里上下翻。手机上两栏会挤成两条竖缝，所以
 * md 以下保持原来的「点一行就地展开」—— 同一份 state 支撑两种形态，
 * 不写两套逻辑。
 * ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import {
  failureMessage,
  getDoctorPatientDetail,
  listDoctorPatients,
  shortDate,
  type BackendFailure,
  type DoctorPatientDetail,
  type DoctorPatientRow,
} from '../lib/api';
import { genderLabel } from '../lib/health/summary-text';
import { cn } from '../lib/utils';
import { DoctorShell } from '../components/doctor/DoctorShell';
import { Card } from '../components/ui/Card';
import { Callout } from '../components/ui/Callout';
import { SectionTitle } from '../components/ui/SectionTitle';
import { ChevronRightIcon } from '../components/ui/icons';

export default function DoctorPage() {
  /*
   * 权限守卫已经收进 DoctorShell：它要在没有权限时整屏换掉外观，
   * 而不是在内容区里挂一张卡片。页面本身只管取数与展示。
   */
  return <Workbench />;
}

/* ============================ 工作台 ============================ */

interface ListState {
  loading: boolean;
  failure: BackendFailure | null;
  rows: DoctorPatientRow[];
  total: number;
}

interface DetailState {
  /**
   * 这份详情属于哪个患者。
   *
   * <p>不能只靠 selected 判断：点开 B 的那一帧，React 还没跑到
   * effect 里把 detail 重置，屏幕上会短暂出现"A 的资料挂在 B 名字下面"。
   * 病历这种东西错一帧都不该发生，所以把归属写进状态里一起比。
   */
  forId: number | null;
  loading: boolean;
  failure: BackendFailure | null;
  data: DoctorPatientDetail | null;
}

const LIST_EMPTY: ListState = { loading: true, failure: null, rows: [], total: 0 };
const DETAIL_EMPTY: DetailState = { forId: null, loading: false, failure: null, data: null };

/** 与后端默认页大小一致；后端上限 100，20 条一页医生翻起来不累 */
const PAGE_SIZE = 20;

function Workbench() {
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  /** 改它一次就重发一次请求，供失败时的「重试」用 */
  const [reloadKey, setReloadKey] = useState(0);
  const [list, setList] = useState<ListState>(LIST_EMPTY);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailState>(DETAIL_EMPTY);

  /*
   * 列表：输入后等 300ms 再发请求。
   * 每敲一个字都请求一次的话，姓名输到第三个字时前面两次的结果
   * 可能后到，列表会闪回旧数据 —— 对这个页面来说很干扰。
   */
  useEffect(() => {
    let cancelled = false;

    const timer = window.setTimeout(async () => {
      setList((s) => ({ ...s, loading: true, failure: null }));
      const r = await listDoctorPatients({
        keyword: keyword.trim() || undefined,
        page,
        size: PAGE_SIZE,
      });
      if (cancelled) return;
      setList(
        r.ok
          ? { loading: false, failure: null, rows: r.data.records, total: r.data.total }
          : { loading: false, failure: r.failure, rows: [], total: 0 },
      );
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [keyword, page, reloadKey]);

  /* 详情：跟着选中的行走。切走时丢弃旧结果，避免把 A 的资料显示在 B 下面 */
  useEffect(() => {
    if (selected == null) {
      setDetail(DETAIL_EMPTY);
      return;
    }

    let cancelled = false;
    setDetail({ forId: selected, loading: true, failure: null, data: null });

    void getDoctorPatientDetail(selected).then((r) => {
      if (cancelled) return;
      setDetail(
        r.ok
          ? { forId: selected, loading: false, failure: null, data: r.data }
          : { forId: selected, loading: false, failure: r.failure, data: null },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [selected]);

  const totalPages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));

  /* 换页时清空选中：左栏已经没有那个人了，右栏不能继续挂着他的病历 */
  function gotoPage(next: number) {
    setPage(next);
    setSelected(null);
  }

  return (
    <DoctorShell
      title="医生工作台"
      subtitle="患者授权范围内的就诊资料。只读，不提供诊断建议。"
    >
      {/*
        宽屏两栏、窄屏单列。
        md:grid-cols-[336px_1fr] 而不是比例分栏：左栏是"找人"用的，
        固定宽度才稳定，患者名长短不影响右栏宽度。
      */}
      <div className="md:grid md:grid-cols-[336px_1fr] md:items-start md:gap-4">
        {/* ---------------- 左栏：搜索 + 患者列表 ---------------- */}
        <div className="md:sticky md:top-4">
          <input
            type="search"
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              // 换关键词必须回第一页：否则停在第 3 页而新结果只有 1 页，
              // 会看到「共 5 位」却是空列表。
              setPage(1);
            }}
            placeholder="按姓名或手机号搜索"
            aria-label="按姓名或手机号搜索患者"
            className="h-11 w-full rounded-lg border border-gray-200 bg-surface px-3 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-brand-400 focus:ring-2 focus:ring-brand-100 md:h-9"
          />

          <section className="mt-3">
            <SectionTitle count={list.loading ? '读取中' : `${list.total} 位`}>患者</SectionTitle>

            {list.failure ? (
              /* 读不到是「未知」，不是「危险」，所以用中性色而不是警告色 */
              <Callout
                tone="neutral"
                title="读不到患者列表"
                action={
                  <button
                    type="button"
                    onClick={() => setReloadKey((k) => k + 1)}
                    className="rounded-lg border border-gray-300 bg-surface px-3 py-1 text-xs text-gray-700 hover:border-gray-400"
                  >
                    重试
                  </button>
                }
              >
                <span className="text-xs">{failureMessage(list.failure)}</span>
              </Callout>
            ) : list.loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-[76px] animate-pulse rounded-2xl bg-gray-100 md:h-[72px]" />
                ))}
              </div>
            ) : list.rows.length === 0 ? (
              <Card tone="muted" pad="md">
                <p className="text-sm text-gray-500">
                  {keyword.trim()
                    ? '没有找到符合条件的患者。换一个姓名或手机号再试。'
                    : '授权范围内还没有患者。'}
                </p>
              </Card>
            ) : (
              <>
                <p className="mb-1.5 text-2xs text-gray-400">
                  <span className="md:hidden">点一行展开该患者的就诊资料</span>
                  <span className="hidden md:inline">点一行在右侧查看就诊资料</span>
                </p>
                <ul className="overflow-hidden rounded-2xl border border-gray-200/80 bg-surface shadow-card">
                  {list.rows.map((p) => {
                    const open = selected === p.userId;
                    return (
                      <li key={p.userId} className="border-b border-gray-100 last:border-b-0">
                        <button
                          type="button"
                          onClick={() => setSelected(open ? null : p.userId)}
                          aria-expanded={open}
                          className={cn(
                            'flex w-full items-start gap-2 px-3.5 py-3 text-left transition-colors',
                            open ? 'bg-brand-50/60' : 'hover:bg-gray-50/70',
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span className="text-sm font-semibold text-gray-900">
                                {patientName(p)}
                              </span>
                              <span className="text-2xs text-gray-500">{patientBasics(p)}</span>
                            </span>
                            <span className="mt-0.5 block text-xs leading-relaxed text-gray-600">
                              {chronicText(p.chronics)}
                            </span>
                            <span className="mt-0.5 block text-2xs tabular-nums text-gray-400">
                              病历 {p.recordCount} 份 · 预约 {p.bookingCount} 条 ·{' '}
                              {p.lastVisitDate ? `最近 ${shortDate(p.lastVisitDate)}` : '暂无就诊'}
                            </span>
                          </span>
                          {/* 宽屏详情在右栏，这个"展开箭头"没有意义，只在窄屏显示 */}
                          <span
                            className={cn(
                              'mt-0.5 shrink-0 transition-transform duration-150 md:hidden',
                              open ? 'rotate-90 text-brand-600' : 'text-gray-300',
                            )}
                          >
                            <ChevronRightIcon size={15} />
                          </span>
                        </button>

                        {/* 窄屏：就地展开；宽屏：这一块不渲染，详情走右栏 */}
                        <div className="md:hidden">
                          {open ? (
                            <PatientDetail
                              state={detail.forId === p.userId ? detail : DETAIL_EMPTY}
                            />
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {/* 只有一页时不出现页码；读取中/失败时也不显示，免得挂着一页的旧总数 */}
                {!list.loading && !list.failure && list.total > PAGE_SIZE ? (
                  <div className="mt-2 flex items-center justify-between gap-2 px-1">
                    <span className="text-2xs tabular-nums text-gray-400">
                      第 {page} / {totalPages} 页 · 共 {list.total} 位
                    </span>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        type="button"
                        disabled={page <= 1}
                        onClick={() => gotoPage(page - 1)}
                        className="rounded-lg border border-gray-200 bg-surface px-2.5 py-1 text-xs text-gray-700 transition-colors hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        上一页
                      </button>
                      <button
                        type="button"
                        disabled={page >= totalPages}
                        onClick={() => gotoPage(page + 1)}
                        className="rounded-lg border border-gray-200 bg-surface px-2.5 py-1 text-xs text-gray-700 transition-colors hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        下一页
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </div>

        {/* ---------------- 右栏：详情（仅宽屏） ---------------- */}
        <div className="hidden md:block">
          {selected == null ? (
            <Card tone="muted" pad="lg">
              <p className="text-sm text-gray-500">
                从左侧选择一位患者，这里显示授权范围内的就诊资料。
              </p>
              <p className="mt-1.5 text-2xs leading-relaxed text-gray-400">
                医生工作台只读：不提供诊断、用药或停药建议。数据以院内 HIS 为准。
              </p>
            </Card>
          ) : (
            <Card pad="lg">
              <PatientDetail
                state={detail.forId === selected ? detail : DETAIL_EMPTY}
                variant="pane"
              />
            </Card>
          )}
        </div>
      </div>

      <p className="mt-4 px-1 text-2xs leading-relaxed text-gray-400">
        本页仅展示患者已授权的内容，不能替代院内 HIS 系统。
      </p>
    </DoctorShell>
  );
}

/* ============================ 详情 ============================ */

/**
 * 详情主体。
 *
 * <p>两种形态共用同一份渲染：
 * <ul>
 *   <li>{@code inline}：窄屏，挂在患者行下面，需要自带分隔线和灰底；</li>
 *   <li>{@code pane}：宽屏右栏，外层已经是 Card，不能再来一层边框和底色，
 *       而且要补一个姓名抬头 —— 窄屏靠列表项表明"这是谁"，右栏没有这个上下文。</li>
 * </ul>
 */
function PatientDetail({
  state,
  variant = 'inline',
}: {
  state: DetailState;
  variant?: 'inline' | 'pane';
}) {
  const shell = variant === 'pane' ? '' : 'border-t border-gray-100 bg-gray-50/60 px-3.5 py-3';

  if (state.loading) {
    return (
      <div className={cn('space-y-2', shell)}>
        {[0, 1].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
    );
  }

  if (state.failure) {
    return (
      <div className={shell}>
        <Callout tone="neutral" dense title="读不到这位患者的资料">
          {failureMessage(state.failure)}
        </Callout>
      </div>
    );
  }

  const d = state.data;
  if (!d) return null;

  return (
    <div className={shell}>
      {variant === 'pane' ? (
        <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-gray-100 pb-3">
          <span className="text-base font-semibold text-gray-900">{patientName(d)}</span>
          <span className="text-2xs text-gray-500">患者 #{d.userId} · {patientBasics(d)}</span>
        </div>
      ) : null}

      <dl className="space-y-1.5">
        <InfoRow
          label="性别"
          value={genderLabel(d.gender) ?? '未记录'}
        />
        <InfoRow label="年龄" value={d.age != null ? `${d.age} 岁` : '未记录'} />
        {/* 过敏用告警色：这是开药前唯一必须确认的一项 */}
        <InfoRow
          label="过敏"
          value={joinOrUnrecorded(d.allergies)}
          tone={d.allergies.length > 0 ? 'alert' : undefined}
        />
        <InfoRow label="慢病" value={joinOrUnrecorded(d.chronics)} />
        <InfoRow label="在用药" value={joinOrUnrecorded(d.medications)} />
      </dl>

      <div className="mt-3">
        <SectionTitle emphasis={false} count={recentCountLabel(d.records.length, d.recordCount)}>
          就诊记录
        </SectionTitle>
        {d.records.length === 0 ? (
          <p className="text-xs text-gray-400">授权范围内没有就诊记录。</p>
        ) : (
          <ul className="space-y-1.5">
            {d.records.map((r) => (
              <li key={r.id} className="rounded-xl border border-gray-200 bg-surface px-2.5 py-2">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-xs font-medium tabular-nums text-gray-900">
                    {shortDate(r.visitDate)}
                  </span>
                  {/* 院区显示编码：拿到院方目录前不乱猜中文名，猜错会指向错误的医院 */}
                  <span className="text-2xs text-gray-500">{r.hospitalCode}</span>
                  <span className="ml-auto text-2xs text-gray-400">
                    {r.department ?? '科室未记录'}
                  </span>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-gray-600">
                  {r.diagnosisBrief ?? '这份病历没写诊断'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3">
        <SectionTitle emphasis={false} count={recentCountLabel(d.bookings.length, d.bookingCount)}>
          预约记录
        </SectionTitle>
        {d.bookings.length === 0 ? (
          <p className="text-xs text-gray-400">没有预约记录。</p>
        ) : (
          <ul className="space-y-1.5">
            {d.bookings.map((b) => {
              const st = bookingStatus(b.status);
              return (
                <li
                  key={b.id}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-xl border border-gray-200 bg-surface px-2.5 py-2"
                >
                  <span className="text-xs font-medium tabular-nums text-gray-900">
                    {shortDate(b.visitTime)} {b.visitTime.slice(11, 16)}
                  </span>
                  <span className="text-2xs text-gray-500">{b.department ?? '科室未记录'}</span>
                  <span className={cn('ml-auto rounded px-1.5 py-0.5 text-2xs', st.cls)}>
                    {st.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'alert';
}) {
  return (
    <div className="flex gap-2 text-xs leading-relaxed">
      <dt className="w-12 shrink-0 text-gray-400">{label}</dt>
      <dd className={cn('min-w-0 flex-1', tone === 'alert' ? 'font-medium text-alert' : 'text-gray-900')}>
        {value}
      </dd>
    </div>
  );
}

/* ============================ 展示辅助 ============================ */

/**
 * 详情只返回最近 10 条（后端 RECENT_LIMIT），总数在 recordCount/bookingCount。
 * 标题不说"最近"，医生会把 10 条当成全部病历 —— 这是会直接影响判断的误导。
 */
function recentCountLabel(shown: number, total: number): string {
  return total > shown ? `最近 ${shown} 条 / 共 ${total} 条` : `${shown} 条`;
}

/**
 * 患者显示名。
 *
 * <p>displayName 为空时显示「患者 #id」：编号是真实的，
 * 编出来的名字会让医生在核对身份时走错方向。
 */
function patientName(p: DoctorPatientRow): string {
  const name = p.displayName?.trim();
  return name ? name : `患者 #${p.userId}`;
}

/** 性别与年龄。缺哪项就说哪项没记录，不省略成空白 */
function patientBasics(p: DoctorPatientRow): string {
  const gender = genderLabel(p.gender) ?? '性别未记录';
  const age = p.age != null ? `${p.age} 岁` : '年龄未记录';
  return `${gender} · ${age}`;
}

/** 慢病只露两项，其余折成条数 —— 一行里塞五种病名会挤成一团 */
function chronicText(chronics: string[]): string {
  if (chronics.length === 0) return '慢病：未记录';
  const head = chronics.slice(0, 2).join('、');
  return chronics.length > 2 ? `慢病：${head} 等 ${chronics.length} 项` : `慢病：${head}`;
}

function joinOrUnrecorded(list: string[]): string {
  return list.length > 0 ? list.join('、') : '未记录';
}

/**
 * 预约状态。
 *
 * <p>只翻译后端已知的三个状态；遇到没见过的值原样显示，
 * 不猜成「已完成」—— 把已取消说成完成会直接影响诊疗判断。
 */
function bookingStatus(status: string): { label: string; cls: string } {
  const known: Record<string, { label: string; cls: string }> = {
    CREATED: { label: '待确认', cls: 'bg-alert-solid text-white' },
    CONFIRMED: { label: '已确认', cls: 'bg-appt-solid text-white' },
    CANCELLED: { label: '已取消', cls: 'bg-gray-200 text-gray-600' },
  };
  return known[status] ?? { label: status, cls: 'bg-gray-200 text-gray-700' };
}
