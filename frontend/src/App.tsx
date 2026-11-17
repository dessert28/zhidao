/* ------------------------------------------------------------------
 * 应用外壳：顶部栏 + 内容区
 *
 * 刻意做得很轻 —— 医疗产品的壳不该抢戏，
 * 主要视觉分量留给对话与卡片本身。
 * ------------------------------------------------------------------ */

import { Suspense } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { TEXT_SCALE_OPTIONS, useTextScale } from './hooks/useTextScale';

const NAV = [
  { to: '/', label: '今日' },
  { to: '/chat', label: '问诊' },
  /*
   * 「挂号」紧跟在问诊后面 —— 这两条路通向同一件事。
   * 挂在前面的理由：患者来医院最常做的事就是约号。
   */
  { to: '/booking', label: '挂号' },
  /*
   * 顺序按患者的时间线排：今天要做什么 → 不舒服先问问 → 要挂号
   * → **人到医院了** → 长期管理 → 看历史。
   * 到院那一格不放在最后，因为它是"站在楼里最需要"的页面。
   */
  { to: '/visit', label: '到院' },
  { to: '/health', label: '健康管家' },
  { to: '/records', label: '我的病历' },
  { to: '/summary', label: '就诊摘要' },
] as const;

export default function App() {
  const { pathname } = useLocation();
  const { scale, setScale } = useTextScale();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-4 px-4">
          <Link to="/" className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-700 text-sm font-semibold text-white">
              智
            </span>
            <span className="hidden text-sm font-medium tracking-wide text-gray-800 sm:inline">
              智诊通
            </span>
          </Link>

          {/*
            导航可横向滚动，不换行。
            7 个入口 + 字号切换在 672px 宽里本来就紧，开了"特大"
            （132%）之后必然放不下 —— 第一版就是被挤成一字一行。
            宁可让用户横滑，也不能让"挂号"竖着排成两行。
          */}
          <nav
            className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label="主导航"
          >
            {NAV.map((n) => {
              const active = pathname === n.to;
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  className={
                    'shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors ' +
                    (active
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-gray-500 hover:text-gray-800')
                  }
                  aria-current={active ? 'page' : undefined}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>

          {/*
            字号切换。放在顶栏最右而不是"设置页"里：
            需要它的人不会去翻设置，而翻不到就等于没有。
          */}
          <div
            className="flex shrink-0 items-center rounded-md border border-gray-200 bg-white p-0.5"
            role="group"
            aria-label="字号"
          >
            {TEXT_SCALE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => setScale(o.value)}
                aria-pressed={scale === o.value}
                title={`字号：${o.label}`}
                className={
                  'whitespace-nowrap rounded px-1.5 py-1 text-xs transition-colors ' +
                  (scale === o.value
                    ? 'bg-brand-700 text-white'
                    : 'text-gray-500 hover:text-gray-800')
                }
              >
                {o.label}
              </button>
            ))}
          </div>

          {/*
            设置入口单独一个图标，不放进主导航。
            理由：主导航已经有 7 项，在 672px 宽里放不下、要横滑；
            「设置」排在最后会被挤出去 —— 而评审现场要现场填 Key 时，
            找不到它等于这个功能不存在。
            图标 + aria-label 保证它无论窗口多窄都在。
          */}
          <Link
            to="/settings"
            aria-label="模型设置"
            title="模型设置（填 API Key）"
            aria-current={pathname === '/settings' ? 'page' : undefined}
            className={
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors ' +
              (pathname === '/settings'
                ? 'border-brand-300 bg-brand-50 text-brand-700'
                : 'border-gray-200 bg-white text-gray-500 hover:text-gray-800')
            }
          >
            <GearIcon />
          </Link>
        </div>
      </header>

      {/*
        main 用 flex-col，是为了让页面内部的 min-h-[calc(100dvh-…)] 有一个
        明确的参照：外层不给 flex 上下文，内层的 flex-1 就撑不满，
        输入区会浮在半空而不是贴在内容底部。
      */}
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6">
        <Suspense
          fallback={
            <div className="py-20 text-center text-sm text-gray-400">载入中…</div>
          }
        >
          <Outlet />
        </Suspense>
      </main>

      {/*
        页脚只在「内容页」常驻（病历页那种长页面）。
        对话页在手机上应该是满屏的：页脚常驻会顶掉一屏里最宝贵的那几十像素，
        而且它和输入区叠在一起（曾经在 1280×800 下两者互相压住半个字高）。
        判断依据是路由：问诊页隐藏页脚，隐私声明改由对话页底部那行小字承担。
      */}
      {pathname !== '/' ? (
        <footer className="border-t border-gray-100 px-4 py-4 text-center text-xs leading-relaxed text-gray-400">
          本系统只做信息整理、风险提示与就诊准备，不提供诊断、用药或停药建议。
          <br />
          如有急症请立即拨打 120。
        </footer>
      ) : null}
    </div>
  );
}

/**
 * 齿轮图标。
 *
 * <p>与 MicIcon 同一个理由：手写 SVG 而不引图标库 ——
 * 整个项目只用到两个图标，为它们拉一个库会让首屏多一个 chunk。
 */
function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
