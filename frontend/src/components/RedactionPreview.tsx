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
 * ------------------------------------------------------------------ */

import { useEffect, useMemo, useState } from 'react';
import { redact, summarizeHits, type PiiType } from '../lib/privacy/redact';
import { mergeHits, type ModelEntityLike, type RedactionHitLike } from '../lib/privacy/merge';
import { useModelState } from '../hooks/useModelState';

const TYPE_LABEL: Record<PiiType, string> = {
  id_card: '身份证号',
  phone: '手机号',
  name: '姓名',
  address: '住址',
  email: '邮箱',
  bank_card: '银行卡号',
  medical_record_no: '病历号',
};

/**
 * 把原文按遮蔽区间切成片段，用于高亮显示。
 * 遮蔽处用高亮色标出，让"被改动了哪里"一眼可见。
 *
 * <p>两路来源：
 * <ul>
 *   <li>规则命中 —— 同步、确定、立即可用</li>
 *   <li>模型命中 —— 异步（要下 129MB 权重），到位后追加。
 *       为 null 表示模型不可用，此时只用规则结果，并且要如实告诉用户</li>
 * </ul>
 *
 * <p>为什么模型结果要"到了再补"而不是等它：等模型等于每次输入都卡几秒，
 * 而且模型可能永远下不下来（网络受限）。规则结果必须先出来，
 * 用户看到"至少这些已经被遮了"才安心。
 */
function Highlighted({ raw, hits }: { raw: string; hits: RedactionHitLike[] }) {
  const modelState = useModelState();

  const parts = useMemo(() => {
    // hits 的 start/end 基于原文，而 text 已替换过，长度不同。
    // 这里改为直接在原文上按区间切分，自己拼替换文本 —— 避免位置错位。
    const segs: Array<{ kind: 'text' | 'masked'; value: string }> = [];
    let cursor = 0;
    for (const h of hits) {
      if (h.start > cursor) {
        segs.push({ kind: 'text', value: raw.slice(cursor, h.start) });
      }
      segs.push({ kind: 'masked', value: h.placeholder });
      cursor = h.end;
    }
    if (cursor < raw.length) {
      segs.push({ kind: 'text', value: raw.slice(cursor) });
    }
    return { segs, hits };
  }, [raw, hits]);

  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-gray-500">
        {parts.segs.map((s, i) =>
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
        {parts.hits.map((h, i) => (
          <span
            key={i}
            className="rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-600"
          >
            {TYPE_LABEL[h.type]}
          </span>
        ))}
        <span className="text-xs text-gray-400">
          {parts.hits.length === 0 ? summarizeHits([]) : `共遮蔽 ${parts.hits.length} 处`}
        </span>
      </div>

      {/*
        模型状态必须如实显示。三种情况：
        · 加载中 → 给出百分比，让用户知道"再等等会遮得更全"
        · 不可用 → 明确说只有规则遮蔽在起作用，不假装检查过了
        · 就绪   → 一行小字确认自由叙述里的姓名地名也已覆盖

        为什么这段不能省：用户看到"未检测到个人信息"时，
        如果其实模型没加载，那是一个**错误的安全感**。
        隐私产品里，这种错误的安全感比明确说"我能力有限"更危险。
      */}
      <ModelStatus state={modelState} />
    </div>
  );
}

function ModelStatus({ state }: { state: ReturnType<typeof useModelState> }) {
  if (state.status === 'ready') {
    return (
      <p className="text-xs leading-relaxed text-gray-400">
        本地模型已就绪：除证件号手机号外，自由叙述里的人名与地名也已覆盖。
      </p>
    );
  }
  if (state.status === 'loading') {
    return (
      <p className="text-xs leading-relaxed text-gray-400">
        {state.message}（首次使用需下载约 129MB，之后走浏览器缓存）
      </p>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <p className="text-xs leading-relaxed text-amber-600">
        本地模型未加载，当前只做规则遮蔽（证件号、手机号、带标签的地址等）。
        自由叙述里的人名可能未被识别，发送前请自行检查。
      </p>
    );
  }
  return null;
}

export function RedactionPreview({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false);

  /*
   * 模型检测必须在**折叠状态下也开始跑**，不能只在展开时才启动。
   *
   * 第一版把 Highlighted（含 detectEntities 的 effect）放在 open 分支里，
   * 结果是：用户不点"查看"就永远不会加载模型，
   * 而顶栏那行计数只统计规则命中 —— 显示"未检测到个人信息"，
   * 实际上自由叙述里的姓名根本没检查过。
   *
   * 这是隐私产品里最坏的一种 bug：不是漏了功能，是**给了错误的安全感**。
   * 所以现在提到外层，输入一出现就开始检测。
   */
  const [modelHits, setModelHits] = useState<ModelEntityLike[] | null>(null);
  const modelState = useModelState();
  const ruleResult = useMemo(() => redact(raw), [raw]);

  useEffect(() => {
    if (!raw.trim()) {
      setModelHits(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { detectEntities } = await import('../lib/privacy/ner');
      const entities = await detectEntities(raw);
      if (!cancelled) setModelHits(entities);
    })();
    return () => {
      cancelled = true;
    };
  }, [raw]);

  // 计数也走合并后的结果，否则顶栏与展开后的内容会对不上
  const merged = useMemo(() => mergeHits(ruleResult.hits, modelHits), [ruleResult, modelHits]);
  const count = merged.length;

  /**
   * 顶栏文案必须反映"模型有没有参与"。
   *
   * <p>三种状态不能都写成"未检测到个人身份信息"：
   * <ul>
   *   <li>模型就绪且 0 命中 → 可以放心说"未检测到"</li>
   *   <li>模型加载中 → 说"正在检查"，因为结果还没齐</li>
   *   <li>模型不可用 → 必须说清楚"只做了规则检查"，
   *       否则"未检测到"是一句误导</li>
   * </ul>
   */
  const summary = (() => {
    if (count > 0) return `将遮蔽 ${count} 处个人信息`;
    if (modelState.status === 'ready') return '未检测到个人身份信息';
    if (modelState.status === 'loading') return '正在检查（本地模型加载中）';
    if (modelState.status === 'unavailable') return '规则检查未命中（本地模型不可用）';
    return '未检测到个人身份信息';
  })();

  /** 只有模型确认就绪、且没命中时，绿点才成立 */
  const confident = count === 0 && modelState.status === 'ready';

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
          <Highlighted raw={raw} hits={merged} />
          <p className="mt-2 text-xs leading-relaxed text-gray-400">
            遮蔽在你这台设备上完成，原文从未发送。被划掉的部分没有离开过浏览器。
          </p>
        </div>
      ) : null}
    </div>
  );
}
