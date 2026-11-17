/* ------------------------------------------------------------------
 * 上传前校对 —— 让患者先看到「系统从我的文件里读出了什么」
 *
 * ============ 为什么必须有这一步 ============
 *
 * 抽取结果是规则匹配，不是医学 NLP。它会直接驱动到院页的
 * "接下来去哪几站"，错一项就可能把人指到错误的楼层/科室。
 * 把草稿摆出来、允许改名/删除/新增，是把纠错权交回给最了解
 * 自己病情的人（患者本人）。
 *
 * ============ 隐私边界在这里也要说清楚 ============
 *
 * 患者很容易以为"我在这里改了摘要，是不是原文就被改了"。
 * 不是：原文仍然原样存在本地 IndexedDB，改的只是**提交给服务端的摘要**。
 * 所以文案要明确写"确认后只提交脱敏文本，原文留在这台设备"。
 * ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import { BRIEF_LIMIT, type ExtractionDraft } from '../lib/exam/extract';
import type { ParsedExam } from '../lib/exam/order-parse';

/** 列表里需要一个稳定 key：用数组下标的话，删一行会让后面的输入框串值 */
interface EditableItem extends ParsedExam {
  key: string;
}

export interface ExtractionReviewProps {
  draft: ExtractionDraft;
  /** 正在提交：两个按钮都禁用，避免重复提交 */
  busy?: boolean;
  onConfirm: (edited: ExtractionDraft) => void;
  onCancel: () => void;
}

function newKey(): string {
  return crypto.randomUUID();
}

export function ExtractionReview({
  draft,
  busy = false,
  onConfirm,
  onCancel,
}: ExtractionReviewProps) {
  const [brief, setBrief] = useState(draft.diagnosisBrief);
  const [items, setItems] = useState<EditableItem[]>(() => draft.examItems.map(toEditable));

  /*
   * 重新解析（比如患者换了文件又点了一次「上传」）时，
   * 用新草稿覆盖旧编辑。draft 在父组件里是 state，只有重新解析才会换对象，
   * 因此正常输入不会被打断。
   */
  useEffect(() => {
    setBrief(draft.diagnosisBrief);
    setItems(draft.examItems.map(toEditable));
  }, [draft]);

  const updateItem = (key: string, patch: Partial<ParsedExam>) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  };

  const removeItem = (key: string) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
  };

  const addItem = () => {
    setItems((prev) => [
      ...prev,
      {
        key: newKey(),
        // 新行默认为「其他」：不猜类型，避免把一个未知项目错误地
        // 加进抽血/影像站，导致指引把人带走错楼层。
        name: '',
        placeType: 'OTHER',
        fasting: null,
        evidence: '',
      },
    ]);
  };

  const confirm = () => {
    onConfirm({
      ...draft,
      diagnosisBrief: brief.trim(),
      examItems:
        draft.kind === 'examOrder'
          ? items.map((it) => ({
              name: it.name.trim(),
              placeType: it.placeType,
              fasting: it.fasting,
              evidence: it.evidence,
            }))
          : [],
    });
  };

  return (
    <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-4">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-medium text-gray-900">核对识别结果</h3>
        <span className="rounded bg-surface px-1.5 py-0.5 text-2xs text-brand-700">
          规则抽取
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-gray-500">
        下面是系统从文件里读出来的内容，可以直接修改。确认后只提交脱敏文本，原文仍留在这台设备。
      </p>

      <div className="mt-3">
        <label
          htmlFor="extraction-brief"
          className="text-xs font-medium text-gray-600"
        >
          诊断 / 主诉摘要
        </label>
        <textarea
          id="extraction-brief"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={3}
          maxLength={BRIEF_LIMIT}
          className="mt-1 block w-full resize-y rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm leading-relaxed text-gray-800"
          placeholder="没有抽取到文字，可以手动填写主诉或诊断"
        />
        <div className="mt-1 flex items-center justify-between text-2xs text-gray-400">
          <span>这段摘要会显示在时间轴上；改这里不会改动本地原文。</span>
          <span className="tabular-nums">
            {brief.length}/{BRIEF_LIMIT}
          </span>
        </div>
      </div>

      {draft.kind === 'examOrder' ? (
        <div className="mt-4">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-medium text-gray-600">检查项目</span>
            <span className="text-2xs text-gray-400">{items.length} 项</span>
          </div>

          {items.length === 0 ? (
            <p className="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
              这张单子上没有识别出检查项目。可能是版式不常见或写的是
              「遵医嘱」这类文字 —— 可以手动新增，也可以取消后按原文处理。
            </p>
          ) : (
            <ul className="mt-1.5 space-y-2">
              {items.map((it) => (
                <li
                  key={it.key}
                  className="rounded-lg border border-gray-200 bg-surface p-2.5"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={it.name}
                      onChange={(e) => updateItem(it.key, { name: e.target.value })}
                      placeholder="检查项目名"
                      aria-label="检查项目名"
                      className="h-8 min-w-0 flex-1 rounded-lg border border-gray-200 px-2 text-sm text-gray-800"
                    />
                    <select
                      value={it.placeType}
                      onChange={(e) =>
                        updateItem(it.key, {
                          placeType: e.target.value as ParsedExam['placeType'],
                        })
                      }
                      aria-label="项目类型"
                      className="h-8 shrink-0 rounded-lg border border-gray-200 px-1.5 text-xs text-gray-700"
                    >
                      <option value="LAB">抽血</option>
                      <option value="EXAM">检查</option>
                      <option value="OTHER">其他</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => removeItem(it.key)}
                      className="h-8 shrink-0 rounded-lg px-2 text-xs text-gray-400 hover:bg-red-50 hover:text-red-600"
                    >
                      删除
                    </button>
                  </div>

                  <div className="mt-1 flex items-center gap-2 text-2xs">
                    {it.fasting === true ? (
                      <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
                        需空腹
                      </span>
                    ) : it.fasting === false ? (
                      <span className="shrink-0 rounded bg-gray-50 px-1.5 py-0.5 text-gray-500">
                        无需空腹
                      </span>
                    ) : (
                      <span className="shrink-0 rounded bg-gray-50 px-1.5 py-0.5 text-gray-500">
                        空腹要求未识别
                      </span>
                    )}
                    {it.evidence ? (
                      <span className="min-w-0 truncate text-gray-400" title={it.evidence}>
                        原文：{it.evidence}
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={addItem}
            className="mt-2 rounded-lg border border-gray-300 bg-surface px-3 py-1 text-xs text-gray-700 hover:border-brand-300"
          >
            + 新增一项
          </button>
        </div>
      ) : null}

      <p className="mt-3 rounded-lg bg-surface/70 px-3 py-2 text-xs leading-relaxed text-gray-500">
        {draft.kind === 'examOrder' ? (
          <>
            检查项目是规则抽取，可能有遗漏或误判，
            <b className="font-medium text-gray-700">请以检查单原文为准</b>。
          </>
        ) : (
          <>
            摘要来自脱敏文本，可能与原文有出入，
            <b className="font-medium text-gray-700">请以原始病历为准</b>。
          </>
        )}
        确认后提交的是脱敏文本；原始文件不会离开这台设备。
      </p>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          className="h-9 rounded-lg bg-action px-4 text-sm font-medium text-white transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {busy ? '保存中…' : '确认保存'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="h-9 rounded-lg border border-gray-200 bg-surface px-4 text-sm text-gray-700 hover:border-gray-300 disabled:cursor-not-allowed disabled:text-gray-400"
        >
          取消
        </button>
      </div>
    </div>
  );
}

function toEditable(item: ParsedExam): EditableItem {
  return { ...item, key: newKey() };
}
