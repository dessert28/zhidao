/* ------------------------------------------------------------------
 * 问诊主页 —— 主链路入口
 * ------------------------------------------------------------------ */

import { useEffect, useRef, useState } from 'react';
import { useEventStream } from '../hooks/useEventStream';
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
    void send({ text: safe });
    setInput('');
    taRef.current?.focus();
  };

  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col">
      {turns.length === 0 ? (
        <div className="flex flex-1 flex-col justify-center py-8">
          <h1 className="text-xl font-semibold tracking-tight text-gray-900">
            说说哪里不舒服
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-500">
            我会帮你判断该挂哪个科、要准备什么。涉及急症时我会直接提示你去急诊，不走其他流程。
          </p>

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
            示例可直接点击。所有内容仅作就诊参考，不构成诊断。
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
        <div className="flex items-end gap-2">
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
