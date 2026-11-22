/* ------------------------------------------------------------------
 * 公告管理
 *
 * ============ 草稿为什么必须存在 ============
 *
 * 公告是唯一"发出去就有人看"的内容，写错一句就是全院广播。所以编辑
 * 和发布分两步：先存草稿，看过预览再发布。患者端首页只拉
 * PUBLISHED 且已到发布时间的公告 —— 这条规则写在接口里，不靠管理员
 * 记得别发。
 *
 * ============ 级别只影响强调色，不影响排序 ============
 *
 * INFO / WARN / URGENT 是给患者的"要不要现在处理"，所以配色借用
 * 语义色：蓝=信息、琥珀=注意、红=紧急。置顶才是排序手段，
 * 级别和排序分开，避免"红色自然浮到最上面"这种隐式规则。
 * ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import {
  AdminField,
  AdminShell,
  adminFieldClass,
  adminTextareaClass,
} from '../../components/admin/AdminShell';
import { Button } from '../../components/ui/Button';
import { Callout } from '../../components/ui/Callout';
import { Card } from '../../components/ui/Card';
import { SectionTitle } from '../../components/ui/SectionTitle';
import {
  deleteAdminNotice,
  failureMessage,
  listAdminNotices,
  saveAdminNotice,
  type Notice,
} from '../../lib/api';

/** 级别 → 徽章样式。只有这三个值有配色，其他按 INFO 处理 */
const LEVEL_STYLE: Record<string, { label: string; className: string }> = {
  INFO: { label: '信息', className: 'border-appt-line bg-appt-soft text-appt' },
  WARN: { label: '注意', className: 'border-alert-line bg-alert-soft text-alert' },
  URGENT: { label: '紧急', className: 'border-critical-line bg-critical-soft text-critical' },
};

function levelStyle(level: string) {
  return LEVEL_STYLE[level] ?? LEVEL_STYLE.INFO!;
}

interface NoticeForm {
  title: string;
  content: string;
  level: string;
  pinned: boolean;
  status: string;
}

const EMPTY_FORM: NoticeForm = {
  title: '',
  content: '',
  level: 'INFO',
  pinned: false,
  status: 'DRAFT',
};

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  // '2026-11-22T09:30:00' → '2026-11-22 09:30'，只截到分钟就够看
  return iso.slice(0, 16).replace('T', ' ');
}

export default function AdminNoticesPage() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<NoticeForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    void (async () => {
      const r = await listAdminNotices({ page: 1, size: 50 });
      if (!alive) return;
      if (r.ok) setNotices(r.data.records);
      else {
        setNotices([]);
        setError(failureMessage(r.failure));
      }
      setLoading(false);
    })();

    return () => {
      alive = false;
    };
  }, [reloadKey]);

  function openNew() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setEditorOpen(true);
  }

  function openEdit(n: Notice) {
    setEditingId(n.id);
    setForm({
      title: n.title,
      content: n.content,
      level: n.level,
      pinned: n.pinned,
      status: n.status,
    });
    setFormError(null);
    setEditorOpen(true);
  }

  async function submit() {
    setFormError(null);
    if (!form.title.trim()) {
      setFormError('标题必填');
      return;
    }
    if (!form.content.trim()) {
      setFormError('内容必填 —— 只有标题的公告患者看不懂');
      return;
    }

    setSaving(true);
    const r = await saveAdminNotice(
      {
        title: form.title.trim(),
        content: form.content.trim(),
        level: form.level,
        pinned: form.pinned,
        status: form.status,
      },
      editingId ?? undefined,
    );
    setSaving(false);

    if (!r.ok) {
      setFormError(failureMessage(r.failure));
      return;
    }

    setEditorOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setReloadKey((k) => k + 1);
  }

  async function remove(n: Notice) {
    const yes = window.confirm(`确定删除公告「${n.title}」吗？已发布的公告会立刻从患者端消失。`);
    if (!yes) return;
    const r = await deleteAdminNotice(n.id);
    if (!r.ok) {
      setError(failureMessage(r.failure));
      return;
    }
    if (editingId === n.id) {
      setEditorOpen(false);
      setEditingId(null);
    }
    setReloadKey((k) => k + 1);
  }

  return (
    <AdminShell
      title="公告管理"
      subtitle="管理患者端首页的公告条"
      action={<Button onClick={openNew}>新建公告</Button>}
    >
      <Callout tone="neutral" dense className="mb-3">
        草稿不会出现在患者端首页 —— 患者端只拉已发布且已到时间的公告。
      </Callout>

      {editorOpen ? (
        <Card className="mb-3">
          <SectionTitle>{editingId == null ? '新建公告' : `编辑公告 #${editingId}`}</SectionTitle>

          <div className="space-y-2.5">
            <AdminField label="标题">
              <input
                className={adminFieldClass}
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="例如 本周六门诊楼停水通知"
              />
            </AdminField>

            <AdminField label="内容" hint="患者端整段显示，建议 60 字以内">
              <textarea
                className={adminTextareaClass}
                rows={4}
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder="写清楚影响谁、什么时候、需要做什么"
              />
            </AdminField>

            <div className="grid gap-2.5 sm:grid-cols-3">
              <AdminField label="级别">
                <select
                  className={adminFieldClass}
                  value={form.level}
                  onChange={(e) => setForm({ ...form, level: e.target.value })}
                >
                  <option value="INFO">信息（蓝）</option>
                  <option value="WARN">注意（琥珀）</option>
                  <option value="URGENT">紧急（红）</option>
                </select>
              </AdminField>

              <AdminField label="发布状态">
                <select
                  className={adminFieldClass}
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  <option value="DRAFT">草稿</option>
                  <option value="PUBLISHED">已发布</option>
                </select>
              </AdminField>

              <AdminField label="置顶">
                <label className="flex h-9 items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={form.pinned}
                    onChange={(e) => setForm({ ...form, pinned: e.target.checked })}
                    className="h-4 w-4 accent-brand-600"
                  />
                  排在公告条最前
                </label>
              </AdminField>
            </div>
          </div>

          {formError ? (
            <Callout tone="critical" dense className="mt-2.5">
              {formError}
            </Callout>
          ) : null}

          <div className="mt-3 flex gap-2">
            <Button onClick={() => void submit()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditorOpen(false);
                setEditingId(null);
              }}
              disabled={saving}
            >
              取消
            </Button>
          </div>
        </Card>
      ) : null}

      {error ? (
        <Callout tone="critical" dense title="公告列表没取到" className="mb-2">
          {error}
        </Callout>
      ) : null}

      {loading ? (
        <div className="py-16 text-center text-xs text-gray-400">载入中…</div>
      ) : notices.length === 0 ? (
        <Card>
          <div className="py-10 text-center">
            <div className="text-sm text-gray-600">还没有公告</div>
            <div className="mt-1 text-xs text-gray-400">点右上角「新建公告」写第一条</div>
          </div>
        </Card>
      ) : (
        <ul className="space-y-2">
          {notices.map((n) => {
            const lv = levelStyle(n.level);
            return (
              <li key={n.id}>
                <Card pad="sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`rounded border px-1.5 py-0.5 text-2xs ${lv.className}`}>
                      {lv.label}
                    </span>
                    <span
                      className={
                        'rounded px-1.5 py-0.5 text-2xs ' +
                        (n.status === 'PUBLISHED'
                          ? 'bg-brand-50 text-brand-700'
                          : 'bg-gray-100 text-gray-500')
                      }
                    >
                      {n.status === 'PUBLISHED' ? '已发布' : '草稿'}
                    </span>
                    {n.pinned ? (
                      <span className="rounded bg-gray-900 px-1.5 py-0.5 text-2xs text-white">置顶</span>
                    ) : null}
                    <span className="ml-auto text-2xs tabular-nums text-gray-400">
                      {formatTime(n.publishedAt ?? n.createdAt)}
                    </span>
                  </div>

                  <div className="mt-1.5 text-sm font-medium text-gray-900">{n.title}</div>
                  <div className="mt-1 line-clamp-3 text-xs leading-relaxed text-gray-500">
                    {n.content}
                  </div>

                  <div className="mt-2 flex gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => openEdit(n)}>
                      编辑
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => void remove(n)}>
                      删除
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </AdminShell>
  );
}
