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
import { useTts } from '../hooks/useTts';

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

/**
 * 语音播报行 —— 「念给你听」的落点。
 *
 * <p>为什么不做成自动播放：浏览器的自动播放策略要求**有用户手势**，
 * 没有手势调用 `speechSynthesis.speak()` 会静默失败（控制台也不会报错）。
 * 硬要自动播的结果是"演示时有时能响有时不响"，比不做还糟。
 * 所以这里给一个明确的按钮，点一下才念。
 *
 * <p>紧急指引（红线事件的 speech）是最需要被听见的场景 ——
 * 用户这时候可能没在看屏幕。它落在 EmergencyCard 下方，
 * 形状与普通播报一致，不给特殊样式（红色已经用在警示卡上，
 * 再红一遍会稀释）。
 */
function SpeechRow({ text }: { text: string }) {
  const tts = useTts();
  if (!tts.supported || !text) return null;

  const speaking = tts.status === 'speaking';

  return (
    <div className="flex items-center gap-2 text-xs text-gray-400">
      <span className="h-px w-4 bg-gray-200" />
      <button
        type="button"
        onClick={() => tts.toggle(text)}
        aria-label={speaking ? '停止朗读' : '朗读这段内容'}
        className={
          'inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors ' +
          (speaking ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-100 hover:text-gray-600')
        }
      >
        <SpeakerIcon speaking={speaking} />
        {speaking ? '停止朗读' : '朗读'}
      </button>
      {!tts.hasZhVoice ? (
        <span className="text-gray-300" title="系统里没有中文语音包，音色可能带口音">
          （未检测到中文音色）
        </span>
      ) : null}
    </div>
  );
}

function SpeakerIcon({ speaking }: { speaking: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      {speaking ? (
        <>
          <line x1="18" y1="9" x2="23" y2="15" />
          <line x1="23" y1="9" x2="18" y2="15" />
        </>
      ) : (
        <>
          <path d="M15.5 9.5a5 5 0 0 1 0 5" />
          <path d="M18.5 7a9 9 0 0 1 0 10" />
        </>
      )}
    </svg>
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

    /* 语音播报：可点开听。事件本身只带 text，念什么由这里决定 */
    case 'speech':
      return <SpeechRow text={event.text} />;

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
