/* ------------------------------------------------------------------
 * AdminShell —— 管理后台外壳（独立布局）
 *
 * ============ 为什么不再用共用的 WorkspaceShell ============
 *
 * 原版本只把"五个模块 + 谁能进"钉在这里，布局交给一个用 tabs 参数
 * 驱动的通用外壳。那个外壳的品牌区写死 `to="/" state={{stay:true}}`
 * —— 在后台点自己的品牌，却被送到患者端首页。语义错了：工作台是
 * 独立的工作场所，不是患者端的附属页面。
 *
 * 现在外壳由本文件自己拥有：品牌回 /admin、侧栏按职能分组、顶栏有
 * 面包屑。医生端另写一份 —— 两端布局代码的少量重复是有意的。
 *
 * ============ 权限守卫只做体验，不做安全 ============
 *
 * currentRole() 读 sessionStorage，任何人都能改。它拦住的只是
 * "患者不小心点进 /admin 看到一堆 403"这种体验问题。真正的边界在
 * 后端：每个 /api/admin/** 端点都标了 hasRole("ADMIN")。
 * ------------------------------------------------------------------ */

import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Card } from '../ui/Card';
import { buttonClass } from '../ui/Button';
import { currentRole } from '../../lib/api';
import { cn } from '../../lib/utils';
import Logo from '../ui/Logo';
import {
  RecordsIcon,
  PinIcon,
  ReportIcon,
  SheetIcon,
  UserIcon,
} from '../ui/icons';
import {
  WorkspaceField,
  workspaceFieldClass,
  workspaceTextareaClass,
} from '../workspace/WorkspaceShell';

/**
 * 侧栏按职能分三段，而不是五条平级入口。
 * 五条平铺时用户得自己推断"院区与科室"和"用户"是不是一类东西；
 * 分组直接把心智模型画出来：看数据 → 管对象 → 配系统。
 */
const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ to: string; label: string; icon: ReactNode; exact?: boolean }>;
}> = [
  {
    label: '总览',
    items: [{ to: '/admin', label: '概览', icon: <SheetIcon size={16} />, exact: true }],
  },
  {
    label: '用户与组织',
    items: [
      { to: '/admin/users', label: '用户', icon: <UserIcon size={16} /> },
      { to: '/admin/hospitals', label: '院区与科室', icon: <PinIcon size={16} /> },
    ],
  },
  {
    label: '内容与系统',
    items: [
      { to: '/admin/notices', label: '公告', icon: <ReportIcon size={16} /> },
      { to: '/admin/knowledge', label: '导诊知识库', icon: <RecordsIcon size={16} /> },
    ],
  },
];

function isActive(pathname: string, to: string, exact?: boolean): boolean {
  if (exact) return pathname === to || pathname === `${to}/`;
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** 面包屑末段：从当前路径反查侧栏标题，查不到就退回传入的 title */
function currentLabel(pathname: string, fallback: string): string {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (isActive(pathname, item.to, item.exact)) return item.label;
    }
  }
  return fallback;
}

export interface AdminShellProps {
  title: string;
  subtitle?: string;
  /** 右侧操作（新建用户、新建公告这类） */
  action?: ReactNode;
  children: ReactNode;
}

export function AdminShell({ title, subtitle, action, children }: AdminShellProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  if (currentRole() !== 'ADMIN') {
    return (
      <div className="flex min-h-dvh items-start justify-center bg-gray-50/70 px-4 py-16">
        <Card className="w-full max-w-md">
          <h1 className="text-base font-semibold text-gray-900">需要管理员权限</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-gray-500">
            当前账号不是院方管理员，管理后台仅对管理员开放。用管理员账号登录后再回来。
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

  const here = currentLabel(pathname, title);

  return (
    <div className="flex min-h-dvh bg-gray-50/70">
      {/* ---------------- 桌面侧栏 ---------------- */}
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-gray-200 bg-surface px-3 py-4 md:flex">
        {/* 品牌 = 本工作台首页。不再带 stay 跳患者端。 */}
        <Link to="/admin" className="mb-5 flex items-center gap-2 px-2" aria-label="管理后台首页">
          <Logo size={30} />
          <span className="min-w-0">
            <span className="block text-sm font-semibold leading-tight text-gray-900">智诊通</span>
            <span className="block text-2xs leading-tight text-gray-400">管理后台</span>
          </span>
        </Link>

        <nav aria-label="管理后台导航" className="flex-1 space-y-4 overflow-y-auto">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="mb-1 px-2.5 text-2xs font-medium tracking-wide text-gray-400">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
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
              </div>
            </div>
          ))}
        </nav>

        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="rounded-xl bg-gray-50/80 px-3 py-2.5 text-2xs leading-relaxed text-gray-500">
            <div className="font-medium text-gray-600">院方管理员</div>
            <div className="mt-0.5">平台级角色 · 权限以后端为准</div>
          </div>
        </div>
      </aside>

      {/* ---------------- 右侧：手机顶部条 + 内容 ---------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-20 border-b border-gray-200/80 bg-surface/90 backdrop-blur-md md:hidden">
          <div className="flex h-12 items-center gap-2 px-4">
            <Link to="/admin" className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
              <Logo size={22} />
              管理后台
            </Link>
            <span className="ml-auto text-2xs text-gray-400">管理后台</span>
          </div>
          <nav
            aria-label="管理后台导航"
            className="overflow-x-auto px-3 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <div className="flex gap-1 rounded-xl bg-gray-100/80 p-1">
              {NAV_GROUPS.flatMap((g) => g.items).map((item) => {
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
            {/* 桌面面包屑：让"我在哪"不必回侧栏找 */}
            <nav
              aria-label="面包屑"
              className="mb-3 hidden items-center gap-1.5 text-2xs text-gray-400 md:flex"
            >
              <Link to="/admin" className="hover:text-brand-700">
                管理后台
              </Link>
              <span aria-hidden="true">/</span>
              <span className="text-gray-600">{here}</span>
            </nav>

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

/* ---------------- 兼容旧引用 ----------------
 * 五个后台页面都从 './AdminShell' 里取这几个名字，保持不动。
 */
export const adminFieldClass = workspaceFieldClass;
export const adminTextareaClass = workspaceTextareaClass;
export const AdminField = WorkspaceField;

export default AdminShell;
