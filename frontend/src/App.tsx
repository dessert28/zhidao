/* ------------------------------------------------------------------
 * 应用外壳：顶部栏 + 内容区
 *
 * 刻意做得很轻 —— 医疗产品的壳不该抢戏，
 * 主要视觉分量留给对话与卡片本身。
 * ------------------------------------------------------------------ */

import { Suspense } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';

const NAV = [
  { to: '/', label: '问诊' },
  { to: '/records', label: '我的病历' },
] as const;

export default function App() {
  const { pathname } = useLocation();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-4 px-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-700 text-sm font-semibold text-white">
              智
            </span>
            <span className="text-sm font-medium tracking-wide text-gray-800">智诊通</span>
          </Link>

          <nav className="ml-auto flex items-center gap-1">
            {NAV.map((n) => {
              const active = pathname === n.to;
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  className={
                    'rounded-md px-3 py-1.5 text-sm transition-colors ' +
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
