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

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
        <Suspense
          fallback={
            <div className="py-20 text-center text-sm text-gray-400">载入中…</div>
          }
        >
          <Outlet />
        </Suspense>
      </main>

      <footer className="border-t border-gray-100 px-4 py-4 text-center text-xs leading-relaxed text-gray-400">
        本系统只做信息整理、风险提示与就诊准备，不提供诊断、用药或停药建议。
        <br />
        如有急症请立即拨打 120。
      </footer>
    </div>
  );
}
