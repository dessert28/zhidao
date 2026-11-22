/* ------------------------------------------------------------------
 * 隐私与授权 —— 患者视角的「谁看了我的数据」
 *
 * ============ 为什么这块必须存在 ============
 *
 * 我们做的是「就诊即授权」：患者去医院挂号，院方就能调阅报告，
 * 不需要他掏手机点同意（那样老年患者根本操作不了）。
 *
 * 但「默示同意」只有在**患者事后能查看**的前提下才站得住：
 * 不知道谁看过自己的病历，任何授权都是黑箱。
 * 所以这块不是附加功能，是那套授权设计成立的前提。
 *
 * ============ 界面要说清的三件事 ============
 *
 * 1. 谁看过（哪家医院、什么时候）
 * 2. 看了多少（几条记录、是否已归档）
 * 3. 怎么限制（关掉自动授权、作废匹配码）
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useState } from 'react';
import { SectionTitle } from './ui/SectionTitle';
import {
  createBinding,
  getAccessLog,
  getAutoGrant,
  hospitalName,
  listBindings,
  setAutoGrant,
  type AccessLogItem,
  type BindingItem,
  type BackendFailure,
} from '../lib/api';

/** 动作类型 → 中文描述 */
const ACTION_LABEL: Record<string, { text: string; tone: 'view' | 'warn' | 'ok' }> = {
  VIEW_REPORT_DETAIL: { text: '调阅了你的报告', tone: 'view' },
  VIEW_REPORT_LIST: { text: '查看了你的报告列表', tone: 'view' },
  ARCHIVED: { text: '已存入该院病案', tone: 'ok' },
  DENIED: { text: '尝试调阅但被拒绝', tone: 'warn' },
};

export function PrivacySection() {
  const [logs, setLogs] = useState<AccessLogItem[] | null>(null);
  const [bindings, setBindings] = useState<BindingItem[]>([]);
  const [autoGrant, setAuto] = useState<boolean>(true);
  const [failure, setFailure] = useState<BackendFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [logRes, bindRes, autoRes] = await Promise.all([
      getAccessLog(),
      listBindings(),
      getAutoGrant(),
    ]);
    if (!logRes.ok) {
      setFailure(logRes.failure);
      setLogs([]);
      return;
    }
    setFailure(null);
    setLogs(logRes.data);
    if (bindRes.ok) setBindings(bindRes.data);
    if (autoRes.ok) setAuto(autoRes.data.autoGrant);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleAuto = async () => {
    setBusy(true);
    const next = !autoGrant;
    const r = await setAutoGrant(next);
    if (r.ok) {
      setAuto(next);
      setFeedback(
        next
          ? '已开启：就诊期间院方可自动调阅你的报告'
          : '已关闭：院方调阅需你本人逐次确认',
      );
    } else {
      setFeedback('设置失败，请稍后重试');
    }
    setBusy(false);
    setTimeout(() => setFeedback(null), 4000);
  };

  const genCode = async (hospitalCode: string) => {
    setBusy(true);
    const r = await createBinding(hospitalCode);
    if (r.ok) {
      setFeedback(`已生成匹配码 ${r.data.matchCode}，就诊时报给挂号窗口即可`);
      await load();
    } else {
      setFeedback('生成失败，请稍后重试');
    }
    setBusy(false);
    setTimeout(() => setFeedback(null), 6000);
  };

  /*
   * 默认收起。
   *
   * 「谁看过我的数据」必须**可查**，但不是每天要看的 —— 绝大多数时候
   * 访问记录是空的。常驻展开会让它在病历页末尾占掉一整屏，
   * 而那一屏的位置更适合留给「跨院重复检查」这类真正有内容的东西。
   * 收起时保留一句摘要 + 最近的调阅，信息没有消失。
   */
  const [open, setOpen] = useState(false);
  const latest = logs?.length
    ? logs.reduce((a, b) => ((a.createdAt ?? '') > (b.createdAt ?? '') ? a : b))
    : null;

  return (
    <section>
      <SectionTitle
        action={
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800"
          >
            {open ? '收起' : '展开'}
          </button>
        }
      >
        隐私与授权
        <span className="ml-2 text-xs font-normal text-gray-400">谁看过你的数据</span>
      </SectionTitle>

      {!open ? (
        <p className="rounded-xl border border-gray-200 bg-surface px-3 py-2.5 text-xs leading-relaxed text-gray-600">
          {logs === null
            ? '正在读取访问记录…'
            : latest === null
              ? '还没有医院调阅过你的数据。'
              : `共 ${logs!.length} 次调阅，最近一次：${hospitalName(latest.hospitalCode)}${
                  latest.createdAt ? ` · ${latest.createdAt.slice(0, 10)}` : ''
                }。`}
          <span className="text-gray-400"> 点「展开」可关闭自动授权或生成就诊匹配码。</span>
        </p>
      ) : (
        <div>
          {/* 自动授权开关 */}
      <div className="rounded-xl border border-gray-200 bg-surface p-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-gray-900">
              就诊期间自动允许院方调阅
            </div>
            <p className="mt-1 text-xs leading-relaxed text-gray-600">
              你到某家医院就诊时，该院医生可直接调阅你就诊前 30 天内的报告，
              不需要你再操作一次。关闭后，每次调阅都需要你本人确认。
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoGrant}
            aria-label="就诊期间自动允许院方调阅"
            disabled={busy}
            onClick={toggleAuto}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              autoGrant ? 'bg-action' : 'bg-gray-300'
            } disabled:opacity-50`}
          >
            {/*
             * 圆点必须显式 left-0.5 锚定在轨道左端。
             * 只写 absolute 不带 left 时，起点是按钮内的静态位置（按钮默认居中），
             * 再 translate 到 22px 会直接飘出 44px 宽的轨道 —— 表现为圆点跑到开关外面。
             * 轨道 44 / 圆点 20 / 左右各留 2：关 = left 2 + 0，开 = left 2 + 20。
             */}
            <span
              className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-surface shadow-sm transition-transform ${
                autoGrant ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {!autoGrant ? (
          <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs leading-relaxed text-amber-800">
            已关闭自动授权。医生需要你当面确认才能查看 —
            这会让你多一步操作，但数据完全由你控制。
          </p>
        ) : null}
      </div>

      {feedback ? (
        <p className="mt-2 rounded-lg bg-brand-50 px-2.5 py-1.5 text-xs text-brand-800">
          {feedback}
        </p>
      ) : null}

      {/* 匹配码 */}
      <div className="mt-3">
        <div className="mb-1.5 text-xs font-medium text-gray-600">就诊匹配码</div>
        {bindings.length > 0 ? (
          <div className="space-y-1.5">
            {bindings.map((b) => (
              <div
                key={b.matchCode}
                className="flex items-center gap-2 rounded-lg border border-gray-200 bg-surface px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-gray-500">{hospitalName(b.hospitalCode)}</div>
                  <div className="font-mono text-sm font-semibold tracking-wider text-gray-900">
                    {b.matchCode}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void genCode(b.hospitalCode)}
                  disabled={busy}
                  className="shrink-0 text-xs text-gray-400 hover:text-brand-700 disabled:opacity-50"
                >
                  重新生成
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-surface px-3 py-2">
            <p className="text-xs leading-relaxed text-gray-500">
              还没有匹配码。生成后告诉挂号窗口，该院医生本次就诊时就能调阅你的报告。
            </p>
            <button
              type="button"
              onClick={() => void genCode('Z2-JFL')}
              disabled={busy}
              className="mt-2 h-8 rounded-lg bg-action px-3 text-xs font-medium text-white hover:bg-action-hover disabled:opacity-50"
            >
              生成浙大二院的匹配码
            </button>
          </div>
        )}
      </div>

      {/* 访问记录 */}
      <div className="mt-3">
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="text-xs font-medium text-gray-600">访问记录</span>
          {logs && logs.length > 0 ? (
            <span className="text-3xs text-gray-400">{logs.length} 条</span>
          ) : null}
        </div>

        {failure ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            读不到访问记录
            {failure.kind === 'unreachable' ? '（后端未启动）' : ''}
          </div>
        ) : logs === null ? (
          <div className="h-14 animate-pulse rounded-lg bg-gray-100" />
        ) : logs.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-surface px-3 py-3 text-xs text-gray-400">
            还没有医院调阅过你的数据。一旦有调阅，这里会显示是哪家医院、什么时候、看了几条。
          </div>
        ) : (
          <ul className="space-y-1.5">
            {logs.map((l) => {
              const meta = ACTION_LABEL[l.action] ?? { text: l.action, tone: 'view' as const };
              const dot =
                meta.tone === 'ok'
                  ? 'bg-green-500'
                  : meta.tone === 'warn'
                    ? 'bg-amber-500'
                    : 'bg-action';
              return (
                <li
                  key={l.id}
                  className="flex items-start gap-2 rounded-lg border border-gray-200 bg-surface px-3 py-2"
                >
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-xs font-medium text-gray-900">
                        {hospitalName(l.hospitalCode)}
                      </span>
                      <span className="text-xs text-gray-600">{meta.text}</span>
                      {l.itemCount > 0 ? (
                        <span className="text-xs text-gray-400">{l.itemCount} 条</span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-3xs text-gray-400">
                      {l.createdAt?.replace('T', ' ').slice(0, 16)}
                      {l.visitDate ? ` · 就诊日 ${l.visitDate}` : ''}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-gray-400">
        你到院就诊即视为允许该院在该次就诊范围内调阅相关资料（行业惯例）。
        每一次调阅都会记录在这里，你可以随时关闭自动授权。
        我们不会把你的数据提供给任何其他机构。
      </p>
        </div>
      )}
    </section>
  );
}

