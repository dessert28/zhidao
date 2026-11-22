/* ------------------------------------------------------------------
 * DoctorShell —— 医生工作台外壳（独立布局）
 *
 * ============ 侧栏为什么保留 ============
 *
 * 原版只有一项功能，侧栏却仍要挂一条孤零零的入口。重做后侧栏
 * 按"医生真正会做的事"分成三块：查患者、看预留能力、读工作边界。
 * 后两项不是凑数 —— 后端 /api/doctor/brief/{token} 有明确的 501
 * 契约，"只读 + 全院检索"的边界也需要在界面上讲清楚。
 *
 * ============ 品牌区的语义 ============
 *
 * 点品牌回 /doctor（本工作台首页），不再带 stay 跳患者端。
 * 工作台是独立的工作场所，不是患者端的子页面。
 *
 * ============ 权限与语气 ============
 *
 * 医生看的是别人的病历，界面不能有任何"系统在给建议"的暗示。
 * 身份块固定写清只读、授权范围、不提供诊断建议。
 * 权限守卫只做体验：真门禁在后端 hasAnyRole("DOCTOR","ADMIN")。
 * ------------------------------------------------------------------ */

import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Card } from '../ui/Card';
import { buttonClass } from '../ui/Button';
import { currentRole, roleLabel } from '../../lib/api';
import { cn } from '../../lib/utils';
import Logo from '../ui/Logo';
import { HeartIcon, RecordsIcon, LockIcon } from '../ui/icons';

const NAV = [
  { to: '/doctor', label: '患者工作台', icon: <HeartIcon size={16} />, exact: true },
  { to: '/doctor/brief', label: '预问诊摘要', icon: <RecordsIcon size={16} />, exact: false },
  { to: '/doctor/policy', label: '工作边界', icon: <LockIcon size={16} />, exact: false },
];

function isActive(pathname: string, to: string, exact: boolean): boolean {
  if (exact) return pathname === to || pathname === `${to}/`;
  return pathname === to || pathname.startsWith(`${to}/`);
}

export interface DoctorShellProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}

export function DoctorShell({ title, subtitle, action, children }: DoctorShellProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const role = currentRole();

  if (role !== 'DOCTOR' && role !== 'ADMIN') {
    return (
      <div className="flex min-h-dvh items-start justify-center bg-gray-50/70 px-4 py-16">
        <Card className="w-full max-w-md">
          <h1 className="text-base font-semibold text-gray-900">这里是医生工作台</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-500">
            当前账号是{roleLabel(role)}，医生工作台仅对院内医生开放。
          </p>
          <p className="mt-1 text-2xs leading-relaxed text-gray-400">
            账号权限以后端校验为准，这一页只是提示，不是判定依据。
          </p>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className={buttonClass({ variant: 'secondary', className: 'mt-3' })}
          >
            返回上一页
          </button>
        </Card>
      </div>
    );
  }

  const currentLabel =
    NAV.find((n) => isActive(pathname, n.to, n.exact))?.label ?? title;

  return (
    <div className="flex min-h-dvh bg-gray-50/70">
      {/* ---------------- 桌面侧栏 ---------------- */}
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-gray-200 bg-surface px-3 py-4 md:flex">
        <Link to="/doctor" className="mb-5 flex items-center gap-2 px-2" aria-label="医生工作台首页">
          <Logo size={30} />
          <span className="min-w-0">
            <span className="block text-sm font-semibold leading-tight text-gray-900">智诊通</span>
            <span className="block text-2xs leading-tight text-gray-400">医生工作台</span>
          </span>
        </Link>

        <nav aria-label="医生工作台导航" className="flex-1 space-y-0.5">
          {NAV.map((item) => {
            const active = isActive(pathname, item.to, item.exact);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors',
                  active
                    ? 'bg-brand-50 font-semibold text-brand-700'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
                )}
              >
                <span className={cn('shrink-0', active ? 'text-brand-600' : 'text-gray-400')}>
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="rounded-xl bg-gray-50/80 px-3 py-2.5 text-2xs leading-relaxed text-gray-500">
            <div className="font-medium text-gray-600">只读视图</div>
            <div className="mt-0.5">患者授权范围内，不提供诊断建议</div>
          </div>
        </div>
      </aside>

      {/* ---------------- 右侧：手机顶部条 + 内容 ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-20 border-b border-gray-200/80 bg-surface/90 backdrop-blur-md md:hidden">
          <div className="flex h-12 items-center gap-2 px-4">
            <Link to="/doctor" className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
              <Logo size={22} />
              医生工作台
            </Link>
            <span className="ml-auto text-2xs text-gray-400">医生工作台</span>
          </div>
          <nav
            aria-label="医生工作台导航"
            className="overflow-x-auto px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div className="flex gap-1 rounded-xl bg-gray-100/80 p-1">
              {NAV.map((item) => {
                const active = isActive(pathname, item.to, item.exact);
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition-colors',
                      active
                        ? 'bg-surface font-semibold text-brand-700 shadow-card'
                        : 'text-gray-500 hover:text-gray-900',
                    )}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </nav>
        </div>

        <main className="flex-1 px-4 py-5 md:px-8 md:py-6">
          <div className="mx-auto w-full max-w-6xl">
            <nav
              aria-label="面包屑"
              className="mb-3 hidden items-center gap-1.5 text-2xs text-gray-400 md:flex"
            >
              <Link to="/doctor" className="hover:text-brand-700">
                医生工作台
              </Link>
              <span aria-hidden="true">/</span>
              <span className="text-gray-600">{currentLabel}</span>
            </nav>

            {/* 临床边界放在视线上方，不埋在侧栏底部或页尾 */}
            <div className="mb-4 rounded-lg border border-clinical-line bg-clinical-soft px-3 py-2 text-xs leading-relaxed text-clinical">
              只读视图 · 所查资料限于患者授权范围 · 本系统不提供诊断或用药建议
            </div>

            <header className="mb-4 md:mb-5">
              <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
                <div className="min-w-0 flex-1">
                  <h1 className="text-xl font-semibold tracking-tight text-gray-900 md:text-2xl">
                    {title}
                  </h1>
                  {subtitle ? (
                    <p className="mt-1.5 text-sm leading-relaxed text-gray-500">{subtitle}</p>
                  ) : null}
                </div>
                {action ? <div className="shrink-0">{action}</div> : null}
              </div>
            </header>

            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export default DoctorShell;
