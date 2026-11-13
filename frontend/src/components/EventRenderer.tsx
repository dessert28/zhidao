/* ------------------------------------------------------------------
 * EventRenderer —— 生成式 UI 的客户端一侧（docs/10 D7）
 *
 * 两条渲染路径：
 *   1. 服务端已渲染好的 html → 直接用（首帧快，无 hydration 成本）
 *   2. 无 html 或需要接管交互 → 按 type 用本地组件 + props 渲染
 *
 * 这里优先用 html：卡片是纯展示的，服务端已经算好了 DOM，
 * 客户端再做一遍是浪费。把 props 路径留给将来的交互卡。
 * ------------------------------------------------------------------ */

import type { StreamEvent } from '../hooks/useEventStream';

/** 服务端渲染的卡片：直接注入 HTML */
function ServerCard({ html }: { html: string }) {
  return (
    <div
      className="animate-fade-up"
      // 内容由本仓库自己的 server/render/registry.tsx 产出，
      // 不含用户输入的原样拼接（所有文本都经过 React 转义），
      // 因此这里注入是安全的。
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** 未渲染的上下文事件：折叠成一行浅色说明，不干扰主内容 */
function MetaLine({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-gray-400">
      <span className="h-px w-4 bg-gray-200" />
      {label}
    </div>
  );
}

export function EventRenderer({ event }: { event: StreamEvent }) {
  switch (event.type) {
    /* 有服务端渲染产物的，一律直接用 */
    case 'department_card':
    case 'emergency':
    case 'caveat':
    case 'timeline_card':
    case 'review_trace':
      return event.html ? <ServerCard html={event.html} /> : null;

    /* 追问：这个未来要带输入框，先给文字形态 */
    case 'clarify':
      return (
        <div className="animate-fade-up rounded-xl border border-brand-200 bg-brand-50 p-4">
          <div className="mb-1 text-xs font-medium text-brand-700">需要补充</div>
          <p className="whitespace-pre-line text-sm text-gray-800">{event.question}</p>
        </div>
      );

    /* 语音播报：显示"正在朗读"，音频播放在 lib/audio 里接 */
    case 'speech':
      return <MetaLine label="已生成语音播报" />;

    /* 以下为过程事件，不做视觉呈现，只在开发时可见 */
    case 'plan':
      return <MetaLine label={`调度：${event.decision}`} />;
    case 'retry':
      return <MetaLine label={`自检未通过，第 ${event.round} 次重试`} />;
    case 'tool_call':
      return <MetaLine label={`调用工具 ${event.name}`} />;
    case 'tool_result':
      return null;
    case 'token':
    case 'done':
      return null;
    default:
      return null;
  }
}

/** 一轮对话的整体渲染 */
export function TurnView({
  userText,
  events,
  text,
  status,
}: {
  userText: string;
  events: StreamEvent[];
  text: string;
  status: 'streaming' | 'done' | 'error';
}) {
  return (
    <div className="space-y-3">
      {/* 用户气泡：右对齐 */}
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-700 px-4 py-2.5 text-sm leading-relaxed text-white">
          {userText}
        </div>
      </div>

      {/* AI 区：左对齐，事件按顺序堆叠 */}
      <div className="space-y-2.5">
        {text ? (
          <p className="whitespace-pre-line text-sm leading-relaxed text-gray-800">
            {text}
            {status === 'streaming' ? <span className="caret" /> : null}
          </p>
        ) : null}

        {events.map((e, i) => (
          <EventRenderer key={`${e.type}-${i}`} event={e} />
        ))}

        {status === 'streaming' && !text ? (
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
            正在思考…
          </div>
        ) : null}
      </div>
    </div>
  );
}
