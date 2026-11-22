/* ------------------------------------------------------------------
 * 用户管理 —— 后台里唯一会"改到别人账号"的页面
 *
 * ============ 为什么改完角色要重新拉列表 ============
 *
 * 后端可能在保存时补默认值、也可能因为唯一约束拒绝写入。本地先把
 * select 改成新值再"假装成功"，一旦请求失败，表格显示的就是一个
 * 不存在的事实 —— 管理员会以为已经改完了。所以每次操作后都重新请求，
 * 让界面显示的永远是后端返回的那份数据。
 *
 * ============ 新建为什么不用 window.prompt ============
 *
 * 建用户要填四个字段，prompt 一次只能问一个，中途取消就留下一半脏状态；
 * 而且 prompt 在手机上会被键盘顶掉、无法校验、没有标签。后台本来就有
 * 空间，展开一张表单卡更清楚。
 * ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import {
  AdminField,
  AdminShell,
  adminFieldClass,
} from '../../components/admin/AdminShell';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { Card } from '../../components/ui/Card';
import { SectionTitle } from '../../components/ui/SectionTitle';
import {
  createAdminUser,
  deleteAdminUser,
  failureMessage,
  listAdminUsers,
  roleLabel,
  updateAdminUser,
  type AdminUser,
  type PageData,
} from '../../lib/api';

const PAGE_SIZE = 20;

const ROLE_OPTIONS = [
  { value: 'PATIENT', label: '患者' },
  { value: 'DOCTOR', label: '医生' },
  { value: 'ADMIN', label: '管理员' },
];

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  // 后端给的是 ISO 时间，列表里只需要日期部分
  return iso.slice(0, 10);
}

export default function AdminUsersPage() {
  // input 里的值和真正提交的搜索词分开：边打字边发请求会把人名打成一半就查空
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<PageData<AdminUser> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 每次写操作后 +1，借 useEffect 统一重拉，避免三个处理函数各写一遍加载逻辑
  const [reloadKey, setReloadKey] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [newRole, setNewRole] = useState('PATIENT');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    void (async () => {
      const r = await listAdminUsers({
        keyword: query || undefined,
        role: role || undefined,
        page,
        size: PAGE_SIZE,
      });
      if (!alive) return;
      if (r.ok) {
        setData(r.data);
      } else {
        setData(null);
        setError(failureMessage(r.failure));
      }
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [query, role, page, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const records = data?.records ?? [];

  async function patchUser(id: number, patch: { role?: string; enabled?: boolean }) {
    const r = await updateAdminUser(id, patch);
    // 失败也要重拉：可能是并发被别人改过，刷新一下让界面回到真实状态
    if (!r.ok) setError(failureMessage(r.failure));
    reload();
  }

  async function removeUser(u: AdminUser) {
    const yes = window.confirm(`确定删除用户「${u.username}」吗？此操作不可撤销。`);
    if (!yes) return;
    const r = await deleteAdminUser(u.id);
    if (!r.ok) setError(failureMessage(r.failure));
    reload();
  }

  async function submitNewUser() {
    setFormError(null);
    if (username.trim().length < 4) {
      setFormError('用户名至少 4 个字符');
      return;
    }
    if (password.length < 6) {
      setFormError('密码至少 6 位');
      return;
    }

    setSubmitting(true);
    const r = await createAdminUser({
      username: username.trim(),
      displayName: displayName.trim() || undefined,
      password,
      role: newRole,
    });
    setSubmitting(false);

    if (!r.ok) {
      setFormError(failureMessage(r.failure));
      return;
    }

    // 收表单、清字段，并回到第一页 —— 新用户通常按创建时间倒序排在最前
    setFormOpen(false);
    setUsername('');
    setDisplayName('');
    setPassword('');
    setNewRole('PATIENT');
    setPage(1);
    reload();
  }

  return (
    <AdminShell
      title="用户管理"
      subtitle="改角色、停用账号、重置不了密码就别建重名号"
      action={
        <Button variant={formOpen ? 'secondary' : 'primary'} onClick={() => setFormOpen((v) => !v)}>
          {formOpen ? '收起表单' : '新建用户'}
        </Button>
      }
    >
      {formOpen ? (
        <Card className="mb-3">
          <SectionTitle>新建用户</SectionTitle>
          <div className="grid gap-2.5 md:grid-cols-4">
            <AdminField label="用户名" hint="4 个字符以上，登录用">
              <input
                className={adminFieldClass}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="例如 zhangsan"
                autoComplete="off"
              />
            </AdminField>
            <AdminField label="显示名" hint="选填，列表里展示的名字">
              <input
                className={adminFieldClass}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="例如 张三"
              />
            </AdminField>
            <AdminField label="初始密码" hint="6 位以上">
              <input
                className={adminFieldClass}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 6 位"
                autoComplete="new-password"
              />
            </AdminField>
            <AdminField label="角色">
              <select
                className={adminFieldClass}
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
              >
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </AdminField>
          </div>

          {formError ? (
            <Callout tone="critical" dense className="mt-2.5">
              {formError}
            </Callout>
          ) : null}

          <div className="mt-3 flex gap-2">
            <Button onClick={() => void submitNewUser()} disabled={submitting}>
              {submitting ? '提交中…' : '创建'}
            </Button>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={submitting}>
              取消
            </Button>
          </div>
        </Card>
      ) : null}

      <Card pad="sm">
        <div className="flex flex-wrap items-end gap-2">
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setQuery(keyword.trim());
            }}
          >
            <input
              className={adminFieldClass}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜用户名或显示名"
              aria-label="搜索用户"
            />
            <Button type="submit" variant="secondary" className="shrink-0">
              搜索
            </Button>
          </form>
          <select
            className={adminFieldClass + ' w-auto shrink-0'}
            value={role}
            aria-label="按角色筛选"
            onChange={(e) => {
              setPage(1);
              setRole(e.target.value);
            }}
          >
            <option value="">全部角色</option>
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {error ? (
        <Callout tone="critical" dense title="操作未完成" className="mt-2">
          {error}
        </Callout>
      ) : null}

      <Card pad="none" className="mt-2 overflow-hidden">
        {loading ? (
          <div className="py-16 text-center text-xs text-gray-400">载入中…</div>
        ) : records.length === 0 ? (
          <div className="py-16 text-center">
            <div className="text-sm text-gray-600">还没有用户</div>
            <div className="mt-1 text-xs text-gray-400">
              {query || role ? '换个关键词或清掉角色筛选试试' : '点右上角「新建用户」添加第一个'}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm md:min-w-0">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
                  <th className="w-[18%] px-3 py-2 font-medium">用户名</th>
                  <th className="w-[16%] px-3 py-2 font-medium">显示名</th>
                  <th className="w-[14%] px-3 py-2 font-medium">角色</th>
                  <th className="w-[12%] px-3 py-2 font-medium">状态</th>
                  <th className="w-[18%] px-3 py-2 font-medium">创建时间</th>
                  <th className="w-[12%] px-3 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {records.map((u) => (
                  <tr key={u.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-3 py-2 md:py-2.5 font-medium text-gray-900">{u.username}</td>
                    <td className="px-3 py-2 md:py-2.5 text-gray-600">{u.displayName || '—'}</td>
                    <td className="px-3 py-2 md:py-2.5">
                      <select
                        className="h-8 rounded-lg border border-gray-200 bg-surface px-1.5 text-xs text-gray-700 outline-none focus:border-brand-400"
                        value={u.role}
                        aria-label={`修改 ${u.username} 的角色`}
                        onChange={(e) => void patchUser(u.id, { role: e.target.value })}
                      >
                        {ROLE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                        {/* 后端若新增了前端还不认识的角色，原样保留，不能因为缺选项就把它悄悄改掉 */}
                        {ROLE_OPTIONS.every((o) => o.value !== u.role) ? (
                          <option value={u.role}>{roleLabel(u.role)}</option>
                        ) : null}
                      </select>
                    </td>
                    <td className="px-3 py-2 md:py-2.5">
                      <button
                        type="button"
                        onClick={() => void patchUser(u.id, { enabled: !u.enabled })}
                        className={
                          'inline-flex h-8 items-center rounded-full px-2.5 text-xs font-medium transition-colors ' +
                          (u.enabled
                            ? 'bg-done-soft text-done hover:bg-done-soft'
                            : 'bg-gray-100 text-gray-500 hover:bg-gray-200')
                        }
                      >
                        {u.enabled ? '已启用' : '已禁用'}
                      </button>
                    </td>
                    <td className="px-3 py-2 md:py-2.5 tabular-nums text-gray-500">{formatDate(u.createdAt)}</td>
                    <td className="px-3 py-2 md:py-2.5 text-right">
                      <Button size="sm" variant="danger" onClick={() => void removeUser(u)}>
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
        <span className="tabular-nums">共 {total} 条</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </Button>
          <span className="tabular-nums">
            {page} / {totalPages}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>
      </div>
    </AdminShell>
  );
}
