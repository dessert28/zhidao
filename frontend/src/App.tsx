/* ------------------------------------------------------------------
 * 应用外壳：顶部栏 + 内容区
 *
 * ============ 导航从 7 项收到 5 项 ============
 *
 * 改版前是「今日 / 问诊 / 挂号 / 到院 / 健康管家 / 我的病历 / 就诊摘要」，
 * 七个入口平铺。问题是它们不在同一个层级上：
 *   · 问诊、挂号、到院 是**动作**，随时会用；
 *   · 健康管家、病历、摘要 是**资料**，是"我去翻一下"才去的。
 * 平铺的结果是顶栏挤到必须横滑，而横滑意味着最后两项等于不存在。
 *
 * 现在只留五个动作级入口，资料全部收进「我的」。
 * 收进去不等于藏起来：首页的英雄区留了六个快捷入口，
 * 高频的那几项仍然一步可达，顶栏只负责"我现在在哪一屏"。
 *
 * ============ 顶栏为什么只放图标 ============
 *
 * 五个导航项 + 三个控件在 672px 里刚好；再塞"标准/大/特大"三个字的
 * 字号按钮就必然溢出（132% 字号下尤其明显）。
 * 所以字号改成**单按钮循环**（标准→大→特大），当前档位写在
 * aria-label 与 title 里；三档的显式选择放在「我的 → 字体大小」，
 * 需要慢慢调的人在那里能一次看全三个选项。
 * ------------------------------------------------------------------ */

import { Suspense } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import Logo from './components/ui/Logo';
import { currentRole, isSignedOut } from './lib/api';
import { GearIcon, MoonIcon, SunIcon, TypeIcon } from './components/ui/icons';
import { TEXT_SCALE_OPTIONS } from './hooks/useTextScale';
import { UiPrefsProvider, useUiPrefs } from './hooks/ui-prefs';

/**
 * 五个一级入口。
 *
 * <p>顺序就是患者的时间线：今天要做什么 → 不舒服先问问 → 要挂号
 * → 人到医院了 → 长期管理。
 * 「到院」不排最后，因为它是"站在楼里最需要"的那一页。
 */
const NAV = [
  { to: '/', label: '首页' },
  { to: '/chat', label: '问诊' },
  { to: '/booking', label: '挂号' },
  { to: '/visit', label: '到院' },
  { to: '/mine', label: '我的' },
] as const;

/**
 * 「我的」下面挂着的子页面。
 *
 * <p>在这几页时顶栏要让「我的」保持选中 —— 否则用户点进病历页后
 * 顶栏 five 项全是灰的，会以为自己走到了导航之外。
 */
const MINE_CHILDREN = ['/mine', '/health', '/records', '/privacy', '/summary', '/settings'] as const;

function isActive(pathname: string, to: string): boolean {
  if (to === '/mine') return MINE_CHILDREN.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (to === '/') return pathname === '/';
  // 二级路径（如 /visit/xxx）也算父项命中
  return pathname === to || pathname.startsWith(`${to}/`);
}

/**
 * Provider 必须在 App 之外：顶栏和页面里都要读同一份字号/主题，
 * 而 App 自己是顶栏的渲染者，没法读到自己提供的 context。
 */
export default function App() {
  return (
    <UiPrefsProvider>
      <AppShell />
    </UiPrefsProvider>
  );
}

function AppShell() {
  const { pathname } = useLocation();
  const { scale, setScale, resolvedTheme: resolved, themeMode: mode, toggleTheme: toggle } =
    useUiPrefs();

  /*
   * 退出后的兜底守卫。
   * 「我的」页退出时会主动 navigate('/login')，这一层是给"后退按钮回到
   * 主应用"和"直接输入地址"准备的：只要用户明确退出了，就不能再被
   * ensureLogin 悄悄登回去。登录/注册/协议页是 App 的兄弟路由，不受影响。
   */
  if (isSignedOut()) return <Navigate to="/login" replace />;

  /*
   * 按角色决定首页落在哪。
   *
   * 管理员登录后停在患者首页是错的体验：他会先看到"今天要吃什么药"，
   * 然后自己去顶栏找一个不存在的后台入口。医生的同理。
   *
   * 这一层不是权限：改前端只能改自己看到什么，改不了接口能返回什么。
   * 工作台里已经没有"回患者端"的链接（两个 Shell 的品牌区各自回本端
   * 首页），所以这里不需要任何绕过标记 —— 唯一的例外是"我的"页里
   * 明确点角色入口时，本来就是去 /admin 或 /doctor，不经过 "/"。
   */
  const role = currentRole();
  if (role === 'ADMIN' && pathname === '/') {
    return <Navigate to="/admin" replace />;
  }
  if (role === 'DOCTOR' && pathname === '/') {
    return <Navigate to="/doctor" replace />;
  }

  /*
   * 工作台（管理端 / 医生端）不套患者端外壳。
   *
   * 患者端是 672px 单列流，服务于"焦虑状态下看一屏"；后台要的是
   * 宽表格、并排图表、侧栏导航。共用一个 <main> 的宽度上限，
   * 等于让后台永远活在手机宽度里 —— 这里直接交出去，由各自的
   * Shell 决定骨架。
   */
  if (pathname.startsWith('/admin') || pathname.startsWith('/doctor')) {
    return (
      <Suspense
        fallback={<div className="py-20 text-center text-sm text-gray-400">载入中…</div>}
      >
        <Outlet />
      </Suspense>
    );
  }

  /*
   * 单按钮循环切档。
   * 顺序固定为 标准 → 大 → 特大 → 标准：只有三档，绕一圈就能回来，
   * 不会像"只放大"那样把人卡在特大档出不去。
   */
  const scaleIndex = TEXT_SCALE_OPTIONS.findIndex((o) => o.value === scale);
  const nextScale = TEXT_SCALE_OPTIONS[(scaleIndex + 1) % TEXT_SCALE_OPTIONS.length] ?? TEXT_SCALE_OPTIONS[0]!;
  const scaleLabel = TEXT_SCALE_OPTIONS[scaleIndex]?.label ?? '标准';

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-gray-200/80 bg-surface/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-2.5 px-4">
          <Link
            to="/"
            aria-label="智诊通 · 回到首页"
            className="flex shrink-0 items-center gap-2 whitespace-nowrap"
          >
            <Logo size={36} />
            <span className="hidden text-sm font-semibold tracking-wide text-gray-900 sm:inline">
              智诊通
            </span>
          </Link>

          {/*
            导航可横向滚动，不换行。
            开了"特大"（132%）之后五项目标在 420px 屏上仍然放不下 ——
            宁可让用户横滑，也不能让「到院」竖着排成两行。
            右侧渐隐是必须的：不加的话最后一项会被硬切一半，看起来像排版坏了。
          */}
          <nav
            className="ml-auto flex min-w-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-18px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label="主导航"
          >
            {NAV.map((n) => {
              const active = isActive(pathname, n.to);
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  className={
                    'shrink-0 rounded-full px-2.5 py-1.5 text-sm transition-colors ' +
                    (active
                      ? 'bg-brand-50 font-semibold text-brand-700'
                      : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900')
                  }
                  aria-current={active ? 'page' : undefined}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>

          {/*
            字号：一个按钮循环三档。
            需要它的人不会去翻设置，翻不到就等于没有 —— 所以它必须在顶栏。
          */}
          <button
            type="button"
            onClick={() => setScale(nextScale.value)}
            aria-label={`字号：当前${scaleLabel}，点一下切到${nextScale.label}`}
            title={`字号：${scaleLabel}（点一下切到${nextScale.label}）`}
            className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg border border-gray-200 bg-surface px-1.5 text-gray-500 transition-colors hover:text-gray-900"
          >
            <TypeIcon size={15} />
            <span className="text-2xs font-medium tabular-nums">{scaleLabel}</span>
          </button>

          {/*
            深色切换。只放一个图标，而不是"跟随系统/浅色/深色"三段控件 ——
            顶栏放不下，三选一留在「我的」页。
          */}
          <button
            type="button"
            onClick={toggle}
            aria-label={resolved === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
            title={
              resolved === 'dark'
                ? '切换到浅色模式'
                : `切换到深色模式${mode === 'system' ? '（现在是跟随系统）' : ''}`
            }
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-surface text-gray-500 transition-colors hover:text-gray-900"
          >
            {resolved === 'dark' ? <SunIcon size={16} /> : <MoonIcon size={16} />}
          </button>

          {/*
            设置单独一个图标。
            理由：评审现场要现场填 Key 时，找不到它等于这个功能不存在。
            「我的」页里也有入口，但顶栏这个是不需要思考的那条路。
          */}
          <Link
            to="/settings"
            aria-label="模型设置"
            title="模型设置（填 API Key）"
            aria-current={pathname === '/settings' ? 'page' : undefined}
            className={
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors ' +
              (pathname === '/settings'
                ? 'border-brand-300 bg-brand-50 text-brand-700'
                : 'border-gray-200 bg-surface text-gray-500 hover:text-gray-900')
            }
          >
            <GearIcon size={16} />
          </Link>
        </div>
      </header>

      {/*
        main 用 flex-col，是为了让页面内部的 min-h-[calc(100dvh-…)] 有一个
        明确的参照：外层不给 flex 上下文，内层的 flex-1 就撑不满，
        输入区会浮在半空而不是贴在内容底部。
      */}
      <main className="page-bg mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-5">
        <Suspense
          fallback={<div className="py-20 text-center text-sm text-gray-400">载入中…</div>}
        >
          <Outlet />
        </Suspense>
      </main>

      {/*
        页脚只在「内容页」常驻。
        首页不显示：首页底部有一条悬浮的「问一句」，页脚会和它叠在一起；
        问诊页也不显示：手机上对话应该满屏。
      */}
      {pathname !== '/' && pathname !== '/chat' ? (
        <footer className="border-t border-gray-100 px-4 py-4 text-center text-xs leading-relaxed text-gray-400">
          本系统只做信息整理、风险提示与就诊准备，不提供诊断、用药或停药建议。
          <br />
          如有急症请立即拨打 120。
        </footer>
      ) : null}
    </div>
  );
}
