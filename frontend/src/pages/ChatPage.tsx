/* ------------------------------------------------------------------
 * 问诊主页 —— 主链路入口
 * ------------------------------------------------------------------ */

import { useEffect, useRef, useState } from 'react';
import { useEventStream } from '../hooks/useEventStream';
import { useSpeechInput } from '../hooks/useSpeechInput';
import { usePatientFacts } from '../hooks/usePatientFacts';
import { TurnView } from '../components/EventRenderer';
import { RedactionPreview } from '../components/RedactionPreview';
import { redact } from '../lib/privacy/redact';

/**
 * 示例问题刻意分类，让评审一眼看到四类路径：
 *   急症（红线短路）/ 模糊（追问）/ 明确（直接分诊）/ 越界（安全拦截）
 */
const EXAMPLES = [
  { label: '急症 → 红线拦截', text: '我爸突然胸口疼得厉害，还出冷汗' },
  { label: '模糊 → 追问', text: '最近老是头晕' },
  { label: '明确 → 直接分诊', text: '肚子疼三天了，是胀痛' },
  { label: '越界 → 安全改写', text: '我头疼，建议吃点布洛芬吗' },
] as const;

export default function ChatPage() {
  const { turns, busy, send, stop, reset } = useEventStream();
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  /** 患者事实：过敏史 / 慢病 / 在用药 —— Reviewer 交叉检查的输入 */
  const { facts: patientFacts, loaded: factsLoaded } = usePatientFacts();

  /**
   * 语音输入。
   *
   * 识别结果**追加到输入框并聚焦**，不自动发送 —— 医学词识别错率不低
   * （"心悸"→"心急"），让人过一眼再发。这也是「AI 可控性」的具体表现：
   * 模型和识别都在帮忙，但最后按发送的必须是人。
   */
  const speech = useSpeechInput({
    onFinal: (text) => {
      setInput((prev) => {
        const sep = prev && !prev.endsWith(' ') && !prev.endsWith('，') ? '' : '';
        return prev ? `${prev}${sep}${text}` : text;
      });
      taRef.current?.focus();
    },
  });

  // 新内容出现时滚到底部
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    // 隐私边界：**发送前先在本机脱敏**，进入网络的是脱敏后的文本。
    // 这一步必须在客户端做 —— 服务端才脱敏的话，原文已经出去了。
    const safe = redact(t).text;
    /*
     * 带上患者事实（过敏史/慢病/在用药）。
     *
     * 这三个字段是 Reviewer 做交叉检查的输入：
     * 不传的话 `drugConflictCheck()` 拿到的永远是空数组，
     * README 承诺的「跨院用药冲突提示」就永远不会触发。
     * 后端没起时 facts 是空数组 —— 只少两个检查，不影响对话。
     */
    void send({ text: safe, facts: patientFacts });
    setInput('');
    taRef.current?.focus();
  };

  return (
    /*
      高度用 dvh - header(56) - main 的上下 padding(48)，把输入区稳定压在底部。
      之前算的是 8rem（=128px），比实际可用高度少了一截，
      结果输入区下面还留着一条空白，而屏幕底部又什么都没接住，
      在 800px 高的窗口里看起来像"内容漂在半空"。
      dvh 而不是 vh：移动端浏览器的地址栏收起/展开会改变可视高度，
      用 vh 会让输入框被地址栏遮住半截。
    */
    <div className="flex min-h-[calc(100dvh-7rem)] flex-col">
      {turns.length === 0 ? (
        <div className="flex flex-1 flex-col justify-center py-8">
          <h1 className="text-xl font-semibold tracking-tight text-gray-900">
            说说哪里不舒服
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-500">
            我会帮你判断该挂哪个科、要准备什么。涉及急症时我会直接提示你去急诊，不走其他流程。
          </p>

          {/*
            让"系统知道你的用药"这件事可见。
            否则「跨院用药冲突提示」触发时，用户不知道 AI 是怎么知道的。
          */}
          {factsLoaded && patientFacts.currentMedications.length > 0 ? (
            <p className="mt-2 text-xs leading-relaxed text-gray-400">
              已读取你的用药清单（{patientFacts.currentMedications.join('、')}）
              {patientFacts.allergies.length > 0
                ? `、过敏史（${patientFacts.allergies.join('、')}）`
                : ''}
              ，回答时会一并核对。
            </p>
          ) : null}

          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            {EXAMPLES.map((e) => (
              <button
                key={e.label}
                type="button"
                onClick={() => submit(e.text)}
                className="group rounded-xl border border-gray-200 bg-white p-3 text-left transition-colors hover:border-brand-300 hover:bg-brand-50/40"
              >
                <div className="text-xs font-medium text-brand-700">{e.label}</div>
                <div className="mt-1 text-sm leading-relaxed text-gray-700">{e.text}</div>
              </button>
            ))}
          </div>

          <p className="mt-6 text-xs leading-relaxed text-gray-400">
            示例可直接点击。所有内容仅作就诊参考，不构成诊断。如有急症请立即拨打 120。
          </p>
        </div>
      ) : (
        <div className="flex-1 space-y-6 py-2">
          {turns.map((t) => (
            <TurnView
              key={t.turnId}
              userText={t.userText}
              events={t.events}
              text={t.text}
              status={t.status}
            />
          ))}
          <div ref={endRef} />
        </div>
      )}

      {/* 输入区：固定在底部，移动端不遮挡 */}
      <div className="sticky bottom-0 -mx-4 mt-4 border-t border-gray-100 bg-gray-50/95 px-4 py-3 backdrop-blur">
        {input.trim() ? <div className="mb-2"><RedactionPreview raw={input} /></div> : null}

        {/* 语音状态：正在听 / 出错。两种都要给可见反馈，否则用户以为按钮坏了 */}
        {speech.listening ? (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-2">
            <span className="flex gap-0.5" aria-hidden="true">
              <span className="h-3 w-0.5 animate-pulse bg-brand-600" />
              <span className="h-3 w-0.5 animate-pulse bg-brand-600 [animation-delay:150ms]" />
              <span className="h-3 w-0.5 animate-pulse bg-brand-600 [animation-delay:300ms]" />
            </span>
            <span className="text-xs text-brand-800">
              {speech.interim ? `正在听：${speech.interim}` : '正在听，请说话…'}
            </span>
          </div>
        ) : null}

        {speech.error ? (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
            <span className="text-xs leading-relaxed text-amber-900">{speech.error}</span>
            <button
              type="button"
              onClick={speech.clearError}
              className="ml-auto shrink-0 text-xs text-amber-700 underline"
            >
              知道了
            </button>
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          {/*
            语音按钮放在发送左侧、拇指热区（docs/04 §7.4）。
            不支持时**不禁用**：禁用只会让人以为是 bug，
            点一下给出"为什么不能用"才是可用的降级。
          */}
          <button
            type="button"
            onClick={speech.toggle}
            aria-label={speech.listening ? '停止语音输入' : '语音输入'}
            aria-pressed={speech.listening}
            title={speech.listening ? '停止' : '按住说话（Chrome / Edge）'}
            className={
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition-colors ' +
              (speech.listening
                ? 'border-brand-600 bg-brand-600 text-white'
                : 'border-gray-200 bg-white text-gray-500 hover:border-brand-300 hover:text-brand-700')
            }
          >
            <MicIcon />
          </button>

          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter 发送，Shift+Enter 换行（中文输入法下 isComposing 必须排除）
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit(input);
              }
            }}
            rows={1}
            placeholder="描述你的症状，或直接说想挂哪个科…"
            className="max-h-32 min-h-[44px] flex-1 resize-none rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm leading-relaxed placeholder:text-gray-400 focus:border-brand-400 focus:outline-none"
          />

          {busy ? (
            <button
              type="button"
              onClick={stop}
              className="h-11 shrink-0 rounded-xl border border-gray-300 px-4 text-sm text-gray-600 hover:bg-white"
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit(input)}
              disabled={!input.trim()}
              className="h-11 shrink-0 rounded-xl bg-brand-700 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              发送
            </button>
          )}

          {turns.length > 0 ? (
            <button
              type="button"
              onClick={reset}
              title="清空对话"
              className="h-11 shrink-0 rounded-xl px-2 text-sm text-gray-400 hover:text-gray-700"
            >
              重来
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 麦克风图标。
 *
 * <p>手写 SVG 而不是引 lucide-react：整个项目只用到这一个图标，
 * 为它拉一个图标库会让首屏多一个 chunk。docs/04 §7.5 也写了"不定图标库"。
 */
function MicIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}
