/* ------------------------------------------------------------------
 * 「我的」—— 资料与设置的家
 *
 * ============ 为什么把病历/管家/摘要收进这里 ============
 *
 * 顶栏那五个入口回答的是"我现在要做什么"：问诊、挂号、到院都是动作。
 * 病历、健康管家、就诊摘要不是动作，是**去翻一下的资料**。
 * 两类东西平铺在顶栏，结果是七个入口挤到必须横滑，最后两个等于不存在。
 *
 * 收进「我的」之后它们并没有变远：首页英雄区里留着六个快捷入口，
 * 高频的那几个仍然一步可达。这一页负责的是"我知道它存在，现在想找它"。
 *
 * ============ 不编姓名 ============
 *
 * PatientProfile 里没有姓名字段。演示版里写过"张伟 / 就诊卡 3201…"，
 * 那是假数据 —— 被问一句"这名字哪来的"就答不上。
 * 所以这里只展示**确实存在**的东西：年龄、性别、慢病条数。
 * 没有档案时就说没有，并给出唯一的下一步动作。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Logo from '../components/ui/Logo';
import { Callout } from '../components/ui/Callout';
import {
  ChevronRightIcon,
  GearIcon,
  HeartIcon,
  LockIcon,
  LogoutIcon,
  MoonIcon,
  RecordsIcon,
  SheetIcon,
  SlidersIcon,
  TypeIcon,
  UserIcon,
  type IconProps,
} from '../components/ui/icons';
import { TEXT_SCALE_OPTIONS } from '../hooks/useTextScale';
import { THEME_OPTIONS } from '../hooks/useTheme';
import { genderLabel } from '../lib/health/summary-text';
import { useUiPrefs } from '../hooks/ui-prefs';
import {
  currentRole,
  ensureLogin,
  getProfile,
  getRecords,
  hospitalName,
  loadHospitalCatalog,
  logout,
  shortDate,
  type BackendFailure,
  type MedicalRecord,
  type PatientProfile,
} from '../lib/api';
import { buildTrends } from '../lib/health/markers';
import { buildCheckupSuggestions } from '../lib/health/checkups';
import { dedupeByLatest, extractMedications } from '../lib/health/medications';
import type { ComponentType, ReactNode } from 'react';

interface State {
  loading: boolean;
  failure: BackendFailure | null;
  profile: PatientProfile | null;
  records: MedicalRecord[];
}

const EMPTY: State = { loading: true, failure: null, profile: null, records: [] };

export default function MinePage() {
  const [state, setState] = useState<State>(EMPTY);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const navigate = useNavigate();
  const { scale, setScale, themeMode, setThemeMode } = useUiPrefs();
  /*
   * 角色只用来决定「显示哪个入口」，不构成权限边界：
   * sessionStorage 里的值谁都能改，真门禁在后端 hasAnyRole("ADMIN") /
   * hasAnyRole("DOCTOR","ADMIN")。这一层存在的唯一理由是
   * 别让患者点进后台撞一脸 403。
   */
  const role = currentRole();

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, failure: null }));

    /*
     * 院区目录也要在这里拉一次。
     *
     * <p>hospitalName() 读的是模块级 Map，只有 loadHospitalCatalog()
     * 成功后才填得上。别的页面拉过就有名字，没拉过就显示成 Z2-JFL ——
     * 同一个页面在"从挂号页进来"和"直接打开链接"两种情况下长得不一样。
     * 放进这个 Promise.all 里，等它回来再 setState，渲染时名字一定就位。
     */
    let [prof, rec] = await Promise.all([getProfile(), getRecords(), loadHospitalCatalog()]);

    const unauthorized =
      (!prof.ok && prof.failure.kind === 'unauthorized') ||
      (!rec.ok && rec.failure.kind === 'unauthorized');
    if (unauthorized) {
      const re = await ensureLogin();
      if (re.ok)
        [prof, rec] = await Promise.all([getProfile(), getRecords(), loadHospitalCatalog()]);
    }

    const failure = (!prof.ok && prof.failure) || (!rec.ok && rec.failure) || null;
    if (failure) {
      setState({ ...EMPTY, loading: false, failure });
      return;
    }

    setState({
      loading: false,
      failure: null,
      profile: prof.ok ? prof.data : null,
      records: rec.ok ? rec.data.records : [],
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const profile = state.profile;
  const records = state.records;

  /* 一句话说清"这是谁的档案"，全部来自真实字段 */
  const identity = profile
    ? [
        profile.age != null ? `${profile.age} 岁` : '',
        genderLabel(profile.gender) ?? '',
        profile.chronics.length > 0 ? `${profile.chronics.length} 项慢病` : '',
        profile.allergies.length > 0 ? `${profile.allergies.length} 项过敏` : '',
      ]
        .filter(Boolean)
        .join(' · ') || '档案还没填完'
    : '还没有建档 · 上传第一份病历就会生成';

  /*
   * 「我的」页原来只是三行跳转：标题 + 一句功能说明 + 箭头。
   * 点进去之前完全不知道里面有什么，于是"资料被收进二级页"这件事
   * 就变成了"资料被藏起来了"。
   *
   * 现在每一格先摆出它最要紧的一两条真实内容 —— 最近一次就诊、
   * 哪项检查到期、有几家在用药。这三份数据本来就是同一批病历算出来的，
   * 在这里多算一遍不需要额外请求。
   */
  const hub = useMemo(() => {
    const trends = buildTrends(records);
    const checkups = buildCheckupSuggestions(profile?.chronics ?? [], records);
    const due = checkups.filter((c) => c.status === 'DUE');
    const meds = dedupeByLatest(
      records.flatMap((r) =>
        extractMedications(r.ocrText ?? '', r.hospitalCode, r.visitDate),
      ),
    );
    const last = [...records].sort((a, b) => b.visitDate.localeCompare(a.visitDate))[0];
    const hospitals = new Set(records.map((r) => r.hospitalCode)).size;
    const abnormal = trends.filter((t) => t.points[t.points.length - 1]!.level !== 'normal');
    return { trends, due, meds, last, hospitals, abnormal };
  }, [records, profile]);

  const latestLevel = hub.abnormal[0]?.points.at(-1);

  return (
    <div className="pb-4">
      {/* 身份行：说的是这份档案，不是编出来的某个人 */}
      <header className="flex items-center gap-3 px-1 pb-5 pt-1">
        <Logo size={52} />
        <div className="min-w-0">
          <div className="text-[17px] font-semibold text-gray-900">我的健康档案</div>
          <div className="mt-0.5 text-xs leading-relaxed text-gray-500">{identity}</div>
        </div>
      </header>

      {state.loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[62px] animate-pulse rounded-2xl bg-gray-100" />
          ))}
        </div>
      ) : state.failure ? (
        <Callout
          tone="neutral"
          title="暂时读不到你的档案"
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
              ? '后端未启动。启动后再试。'
              : state.failure.kind === 'unauthorized'
                ? '登录已失效，请重试。'
                : state.failure.message}
          </span>
        </Callout>
      ) : (
        <>
          <div className="space-y-2.5">
            <HubCard
              to="/records"
              Icon={RecordsIcon}
              title="我的病历"
              meta={
                records.length > 0 ? `${records.length} 份 · ${hub.hospitals} 家医院` : '还没有记录'
              }
              lines={
                hub.last
                  ? [
                      {
                        text: `${hospitalName(hub.last.hospitalCode)} · ${
                          hub.last.department ?? '未记录科室'
                        } · ${shortDate(hub.last.visitDate)}`,
                      },
                      { text: hub.last.diagnosisBrief ?? '这份病历没写诊断', tone: 'muted' },
                    ]
                  : [{ text: '上传第一份病历，跨院时间轴就开始积累了', tone: 'muted' }]
              }
            />

            <HubCard
              to="/health"
              Icon={HeartIcon}
              title="健康管家"
              meta={
                hub.due.length > 0
                  ? `${hub.due.length} 项检查到期`
                  : hub.abnormal.length > 0
                    ? `${hub.abnormal.length} 项指标异常`
                    : '暂无待办'
              }
              lines={
                hub.due.length > 0
                  ? [
                      {
                        text: `该做：${hub.due
                          .slice(0, 2)
                          .map((c) => c.name)
                          .join('、')}${hub.due.length > 2 ? ` 等 ${hub.due.length} 项` : ''}`,
                        tone: 'alert',
                      },
                    ]
                  : hub.abnormal[0]
                    ? [
                        {
                          text: `${hub.abnormal[0].name} ${hub.abnormal[0].latest}${
                            hub.abnormal[0].unit
                          }，${latestLevel?.level === 'high' ? '偏高' : '偏低'}`,
                          tone: 'clinical',
                        },
                      ]
                    : [
                        {
                          text:
                            hub.trends.length > 0
                              ? '最近一次指标都在参考范围内，按计划复查即可'
                              : '上传化验单后，这里会显示指标趋势和该做的检查',
                          tone: 'muted',
                        },
                      ]
              }
            />

            <HubCard
              to="/summary"
              Icon={SheetIcon}
              title="就诊摘要"
              meta={`一页纸 · ${hub.hospitals} 家医院`}
              cta="打印"
              lines={
                records.length > 0
                  ? [
                      {
                        text: `在用药 ${hub.meds.length} 种 · 指标 ${hub.trends.length} 项 · 就诊 ${records.length} 次`,
                      },
                      { text: '打印出来带去门诊，或复制成文字发给医生', tone: 'muted' },
                    ]
                  : [{ text: '还没有内容可打印，先上传病历', tone: 'muted' }]
              }
            />
          </div>

          {/*
            角色入口。插在资料卡之后、显示设置之前：
            医生/管理员进来第一件事就是找自己的工具，往下翻三屏才看到
            等于没有。普通患者这两条都不渲染 —— 一个点进去只会 403 的
            入口比没有更糟。
          */}
          {role === 'ADMIN' || role === 'DOCTOR' ? (
            <Group title="工作台">
              {role === 'ADMIN' ? (
                <RowLink
                  to="/admin"
                  Icon={GearIcon}
                  title="管理后台"
                  sub="用户、院区、公告与数据看板"
                />
              ) : (
                <RowLink
                  to="/doctor"
                  Icon={UserIcon}
                  title="医生工作台"
                  sub="查看患者授权的就诊资料"
                />
              )}
            </Group>
          ) : null}

          <Group title="显示与辅助">
            <RowControl Icon={TypeIcon} title="字体大小" sub="影响所有页面，下次打开仍然生效">
              <Seg
                options={TEXT_SCALE_OPTIONS}
                value={scale}
                onChange={(v) => setScale(v)}
                label="字体大小"
              />
            </RowControl>
            <RowControl Icon={MoonIcon} title="外观" sub="默认跟随系统，系统变暗时自动跟着变">
              <Seg
                options={THEME_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                value={themeMode}
                onChange={(v) => setThemeMode(v)}
                label="外观"
              />
            </RowControl>
          </Group>

          <Group title="模型与数据">
            <RowLink
              to="/settings"
              Icon={SlidersIcon}
              title="模型接口"
              sub="用的是你自己的 API Key"
            />
            <RowLink
              to="/privacy"
              Icon={LockIcon}
              title="隐私与脱敏"
              sub="原文不出设备，看看数据怎么流动"
            />
          </Group>

          {/*
            退出做成两段式：先展开确认，再真正执行。
            原因是这一行和「隐私与脱敏」挨着，单段式点一下就退，
            老人在找设置时很容易误触 —— 而误触退出的代价是整屏被登录页替换。
          */}
          <Group title="账号">
            {confirmLogout ? (
              <div className="px-3.5 py-3">
                <p className="text-sm font-medium text-gray-900">确定要退出登录吗？</p>
                <p className="mt-0.5 text-2xs leading-relaxed text-gray-500">
                  本机保存的病历与设置不会被删除，下次登录仍可查看。
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmLogout(false)}
                    className="flex-1 rounded-lg border border-gray-300 bg-surface px-3 py-2 text-xs text-gray-700 transition-colors hover:border-gray-400"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      logout();
                      navigate('/login', { replace: true });
                    }}
                    className="flex-1 rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-red-700"
                  >
                    确认退出
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmLogout(true)}
                className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-gray-50/70"
              >
                <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-500">
                  <LogoutIcon size={17} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-gray-900">退出登录</span>
                  <span className="mt-0.5 block text-2xs leading-relaxed text-gray-500">
                    退出后需重新登录才能查看健康档案
                  </span>
                </span>
                <span className="shrink-0 text-2xs font-medium text-red-600">退出</span>
              </button>
            )}
          </Group>

          <p className="px-1 pt-4 text-2xs leading-relaxed text-gray-400">
            病历与服药记录只存在这台设备上，换设备不会同步。模型接口的 Key 只保存在这个浏览器里，
            不会出现在任何接口返回或日志中。
          </p>
        </>
      )}
    </div>
  );
}

/* ============================ 结构件 ============================ */

/**
 * 资料区的入口卡。
 *
 * <p>比一行跳转多两样东西：一行真实数据（meta）和一两条内容预览（lines）。
 * 预览不是摘要式复述，而是**点进去最先会看到的那些**——
 * 这样"要不要进去"这个决定在卡片上就能做。
 *
 * <p>整张卡是一个 <Link>，里面不能再放按钮：
 * 嵌套的可交互元素会被读屏器拆成两个焦点，而且点击行为不一致。
 */
function HubCard({
  to,
  Icon,
  title,
  meta,
  lines,
  cta,
}: {
  to: string;
  Icon: ComponentType<IconProps>;
  title: string;
  meta: string;
  lines: { text: ReactNode; tone?: 'alert' | 'clinical' | 'muted' }[];
  cta?: string;
}) {
  const dot = {
    alert: 'bg-alert-solid',
    clinical: 'bg-clinical-solid',
    muted: 'bg-gray-300',
  };

  return (
    <Link
      to={to}
      className="block rounded-2xl border border-gray-200/80 bg-surface p-3.5 shadow-card transition-colors hover:border-brand-200"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
          <Icon size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold text-gray-900">{title}</span>
            <span className="text-2xs tabular-nums text-gray-400">{meta}</span>
          </span>
        </span>
        <span className="shrink-0 text-2xs font-medium text-brand-700">{cta ?? '查看'}</span>
        <span className="shrink-0 text-gray-300">
          <ChevronRightIcon size={15} />
        </span>
      </div>

      {lines.length > 0 ? (
        <ul className="mt-2.5 space-y-1 border-t border-gray-100 pt-2.5">
          {lines.map((l, i) => (
            <li
              key={i}
              className="flex items-start gap-1.5 text-xs leading-relaxed text-gray-600"
            >
              <span
                aria-hidden="true"
                className={
                  'mt-[7px] h-1 w-1 shrink-0 rounded-full ' + dot[l.tone ?? 'muted']
                }
              />
              <span className="min-w-0">{l.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </Link>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-2 first:mt-0">
      <h2 className="px-1.5 pb-2 text-2xs font-medium tracking-wide text-gray-400">{title}</h2>
      {/* 组内用一条卡片承载多行，行间用 1px 分隔线 —— 比每行一张卡安静得多 */}
      <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-surface shadow-card">
        {children}
      </div>
    </section>
  );
}

function RowShell({
  Icon,
  title,
  sub,
  trailing,
  as,
}: {
  Icon: ComponentType<IconProps>;
  title: string;
  sub: string;
  trailing?: ReactNode;
  as?: 'div';
}) {
  const Tag = as ?? 'div';
  return (
    <Tag className="flex items-center gap-3 px-3.5 py-3">
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
        <Icon size={17} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-gray-900">{title}</span>
        <span className="mt-0.5 block text-2xs leading-relaxed text-gray-500">{sub}</span>
      </span>
      {trailing}
    </Tag>
  );
}

function RowLink({
  to,
  Icon,
  title,
  sub,
}: {
  to: string;
  Icon: ComponentType<IconProps>;
  title: string;
  sub: string;
}) {
  return (
    <Link
      to={to}
      className="block border-b border-gray-100 last:border-b-0 transition-colors hover:bg-gray-50/70"
    >
      <RowShell
        Icon={Icon}
        title={title}
        sub={sub}
        trailing={
          <span className="shrink-0 text-gray-300">
            <ChevronRightIcon size={16} />
          </span>
        }
      />
    </Link>
  );
}

function RowControl({
  Icon,
  title,
  sub,
  children,
}: {
  Icon: ComponentType<IconProps>;
  title: string;
  sub: string;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-gray-100 px-3.5 py-3 last:border-b-0">
      <RowShell Icon={Icon} title={title} sub={sub} />
      <div className="pl-[46px] pt-2.5">{children}</div>
    </div>
  );
}

/**
 * 三档分段控件。
 *
 * <p>不用 <select>：原生下拉在手机上会弹一整屏，老人容易点错；
 * 三个并排的按钮一眼能选完，选中的那个还有明确的底色。
 */
function Seg<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex gap-1.5 rounded-xl bg-gray-100 p-1" role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={on}
            className={
              'flex-1 rounded-lg px-2 py-1.5 text-xs transition-colors ' +
              (on
                ? 'bg-surface font-semibold text-brand-700 shadow-card'
                : 'text-gray-500 hover:text-gray-800')
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
