/* ------------------------------------------------------------------
 * RedactionPreview —— 让脱敏这一步「看得见」
 *
 * 为什么值得单独做个组件：
 *   隐私保护如果只是 README 里的一句话，评委不会记住。
 *   让用户在发送前亲眼看到「你的手机号会变成 138****5678」，
 *   这比任何技术描述都有说服力。
 *
 *   而且它有实际功能：用户可以确认 AI 收到的是什么，
 *   发现漏遮时可以自己改 —— 知情权比"相信我"更重要。
 *
 * 它不做计算：
 *   遮蔽结果由 useRedaction 算一次，ChatPage 发送时用的就是同一份。
 *   组件自己再算一遍的话，两处实现迟早分开 —— 那正是这个组件
 *   之前的问题：预览把模型命中也标了出来，发送却只用了规则结果。
 * ------------------------------------------------------------------ */

import { useState } from 'react';
import { summarizeHits, type PiiType } from '../lib/privacy/redact';
import type { RedactionHitLike } from '../lib/privacy/merge';
import type { ModelPhase } from '../hooks/useRedaction';
import { useModelState } from '../hooks/useModelState';

const TYPE_LABEL: Record<PiiType, string> = {
  id_card: '身份证号',
  phone: '手机号',
  address: '住址',
  email: '邮箱',
  bank_card: '银行卡号',
  medical_record_no: '病历号',
};

/**
 * 把原文按遮蔽区间切成片段，用于高亮显示。
 * 遮蔽处用高亮色标出，让"被改动了哪里"一眼可见。
 *
 * <p>直接在原文上按区间切分、自己拼替换文本，而不是用已替换过的字符串：
 * 后者长度已经变了，位置会错位。
 */
function Highlighted({ raw, hits }: { raw: string; hits: RedactionHitLike[] }) {
  const segs = (() => {
    const out: Array<{ kind: 'text' | 'masked'; value: string }> = [];
    let cursor = 0;
    for (const h of hits) {
      if (h.start > cursor) {
        out.push({ kind: 'text', value: raw.slice(cursor, h.start) });
      }
      out.push({ kind: 'masked', value: h.placeholder });
      cursor = h.end;
    }
    if (cursor < raw.length) {
      out.push({ kind: 'text', value: raw.slice(cursor) });
    }
    return out;
  })();

  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-500">
        {segs.map((s, i) =>
          s.kind === 'masked' ? (
            <span
              key={i}
              className="rounded bg-rose-100 px-1 text-rose-700 line-through decoration-rose-400"
              title="已遮蔽，不会发送"
            >
              {s.value}
            </span>
          ) : (
            <span key={i}>{s.value}</span>
          ),
        )}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {hits.map((h, i) => (
          <span key={i} className="rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-600">
            {TYPE_LABEL[h.type]}
          </span>
        ))}
        <span className="text-xs text-gray-400">
          {hits.length === 0 ? summarizeHits([]) : `共遮蔽 ${hits.length} 处`}
        </span>
      </div>
    </div>
  );
}

/**
 * 模型状态必须如实显示。三种情况不能写成同一句话：
 * · 还没结论 → 「正在检查」，因为结果还没齐
 * · 不可用   → 「只做了规则检查」，否则"未检测到"是一句误导
 * · 检查过   → 才可以确认模型这一层也跑过
 *
 * 为什么这段不能省：用户看到"未检测到个人信息"时，
 * 如果其实模型没加载，那是一个**错误的安全感**。
 * 隐私产品里，这种错误的安全感比明确说"我能力有限"更危险。
 *
 * <p>措辞只讲"做了什么"，不承诺"全都遮住了" —— 后者一旦被追问就站不住。
 */
function ModelStatus({ model }: { model: ModelPhase }) {
  const state = useModelState();

  if (model.phase === 'done') {
    return (
      <p className="text-xs leading-relaxed text-gray-400">
        本地模型已检查：除证件号手机号外，机构名与地名也已覆盖。
      </p>
    );
  }
  if (model.phase === 'pending') {
    // 下载进度要能看到，否则 129MB 的首屏等待没有任何反馈
    return (
      <p className="text-xs leading-relaxed text-gray-400">
        {state.status === 'loading'
          ? `正在下载本地脱敏模型 ${state.progress}%（首次约 129MB，之后走浏览器缓存）`
          : '正在本地检查这句话…'}
      </p>
    );
  }
  if (model.phase === 'unavailable') {
    return (
      <p className="text-xs leading-relaxed text-amber-600">
        本地模型未加载，当前只做规则遮蔽（证件号、手机号、带标签的地址等）。发送前请自行检查。
      </p>
    );
  }
  return null;
}

export function RedactionPreview({
  raw,
  hits,
  model,
}: {
  raw: string;
  hits: RedactionHitLike[];
  model: ModelPhase;
}) {
  const [open, setOpen] = useState(false);

  const count = hits.length;

  /**
   * 顶栏文案跟着 model 走，而不是跟着"命中数"走：
   * 0 命中时，模型跑完了才可以说"未检测到"。
   */
  const summary = (() => {
    if (count > 0) return `将遮蔽 ${count} 处个人信息`;
    if (model.phase === 'done') return '未检测到证件号、手机号等信息';
    if (model.phase === 'pending') return '正在检查（本地模型加载中）';
    if (model.phase === 'unavailable') return '规则检查未命中（本地模型不可用）';
    return '未检测到个人身份信息';
  })();

  /** 只有模型确认跑完、且没命中时，绿点才成立 */
  const confident = count === 0 && model.phase === 'done';

  if (!raw.trim()) return null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <span
          className={
            'h-1.5 w-1.5 rounded-full ' +
            (count > 0 ? 'bg-rose-500' : confident ? 'bg-green-500' : 'bg-amber-400')
          }
        />
        <span className="text-xs text-gray-600">{summary}</span>
        <span className="ml-auto text-xs text-gray-400">{open ? '收起' : '查看'}</span>
      </button>

      {open ? (
        <div className="border-t border-gray-100 px-3 py-2.5">
          <div className="mb-1.5 text-xs font-medium text-gray-500">
            AI 实际收到的内容
          </div>
          <Highlighted raw={raw} hits={hits} />
          <p className="mt-2 text-xs leading-relaxed text-gray-400">
            遮蔽在你这台设备上完成，原文从未发送。被划掉的部分没有离开过浏览器。
          </p>
          <ModelStatus model={model} />
        </div>
      ) : null}
    </div>
  );
}
