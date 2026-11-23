/* ------------------------------------------------------------------
 * EventRenderer —— 生成式 UI 的客户端一侧（docs/10 D7）
 *
 * 两条渲染路径：
 *   1. 服务端已渲染好的 html → 直接用（首帧快，无 hydration 成本）
 *   2. 无 html → 按 type 用本地组件 + props 渲染（AgentCards.tsx）
 *
 * 迁移到 Spring Boot 后端后只有第 2 条路了：Java 侧没有 React，
 * 不产出 html。第 1 条保留着 —— 旧 BFF 的产物、以及将来若在别处
 * 做渲染，都还能直接用，不必改这里。
 * ------------------------------------------------------------------ */

import type { StreamEvent } from '../hooks/useEventStream';
import { useTts } from '../hooks/useTts';
import { Link } from 'react-router-dom';
import type { BookingPreview } from '@shared/types/contract';
import { WaitingIndicator } from './WaitingIndicator';
import { CaveatCard, DepartmentCard, EmergencyCard } from './AgentCards';

/** 服务端渲染的卡片：直接注入 HTML（当前 Java 后端不产出，保留兼容路径） */
function ServerCard({ html }: { html: string }) {
  return (
    <div
      className="animate-fade-up"
      // 内容只可能来自本仓库的渲染层（旧 BFF 的 server/render/registry.tsx），
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

/**
 * 预约预览卡 —— 三段式里「在院内」的入口。
 *
 * <p><b>为什么这一张必须是客户端组件</b>：它要带参数跳转到挂号页。
 * 服务端 renderToString 出来的 HTML 没有事件绑定，点了没反应。
 *
 * <p><b>为什么这里只做「去挂号」而不再直接下单</b>：
 * 对话里只有一个"AI 给的第一个时段"，没有选择权 —— 想换时间、想看看
 * 这周哪天有号，都做不到；而且一点就占号，误点无法回滚。
 * 现在这一步只负责**把人带到挂号页**，真正的下单留到挂号页那次显式确认。
 * 少一次"我点错了就占掉一个号"的机会。
 */
export function BookingPreviewCard({ preorder }: { preorder: BookingPreview }) {
  /*
   * 带上院区、科室、日期、时段四个参数过去：
   * 到挂号页就能直接看到这一天这个时段的余量，用户在那一页改日期、换时段。
   *
   * departments 是**推荐科室候选**（首选在前）：挂号页把它渲染成可切换的
   * 科室列表 —— 用户能在这几个科之间换（分诊本来就给了几个方向，
   * 谁都不是唯一答案），但换不到推荐之外的科。要换到别的科，
   * 回问诊重新描述症状，那样分诊会重新给一组推荐。
   */
  const params = new URLSearchParams({
    hospital: preorder.hospitalCode,
    department: preorder.department,
    date: preorder.slot.slice(0, 10),
    slot: preorder.slot,
  });
  if (preorder.departmentOptions && preorder.departmentOptions.length > 0) {
    params.set('departments', preorder.departmentOptions.join(','));
  }
  const to = `/booking?${params.toString()}`;

  return (
    <div className="animate-fade-up rounded-xl border border-brand-200 bg-surface">
      <div className="border-b border-brand-100 bg-brand-50/60 px-4 py-2.5">
        <span className="text-xs font-medium text-brand-700">可预约号源</span>
      </div>

      <div className="px-4 py-3">
        <div className="text-base font-medium text-gray-900">
          {preorder.hospital} · {preorder.department}
        </div>

        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <div className="flex gap-1.5">
            <dt className="text-gray-400">时间</dt>
            <dd className="text-gray-800">
              {preorder.slot.slice(5, 10)} {preorder.slot.slice(11, 16)}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-gray-400">医生</dt>
            <dd className="text-gray-800">{preorder.doctor ?? '普通门诊'}</dd>
          </div>
        </dl>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link
            to={to}
            className="inline-flex h-9 items-center rounded-lg bg-action px-4 text-sm font-medium text-white transition-colors hover:bg-action-hover"
          >
            去挂号
          </Link>
          <span className="text-xs leading-relaxed text-gray-400">
            到挂号页挑时段再确认，这里不会直接占号
          </span>
        </div>
      </div>
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
    /*
     * 卡片：有服务端 html 就用它，没有就本地渲染。
     *
     * 原来这里只有 `<ServerCard>` 一条路，而 AI 迁到 Spring Boot 之后
     * Java 侧不产生 html（没有 React 运行时），于是卡片全部静默消失 ——
     * 用户看到的只有一句「建议优先挂「神经内科」」，红色急症卡也没了。
     * 本地组件是同样的视觉，作为兜底；两条路谁先用谁。
     */
    case 'department_card':
      return event.html ? (
        <ServerCard html={event.html} />
      ) : (
        <DepartmentCard departments={event.departments} />
      );
    case 'emergency':
      return event.html ? <ServerCard html={event.html} /> : <EmergencyCard redFlag={event.redFlag} />;
    case 'caveat':
      return event.html ? <ServerCard html={event.html} /> : <CaveatCard text={event.text} />;

    /* 以下两种后端当前不发，留 html 路径；真发时需补本地组件（否则仍在页面上不可见） */
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

    /*
     * 预约预览卡：**客户端渲染，不走服务端 HTML**。
     *
     * 与其他卡片不同，这张卡有交互（确认挂号会调后端下单）。
     * 服务端 renderToString 出来的 HTML 没有事件绑定，
     * 所以它必须走 props 路径。
     */
    case 'booking_preview_card':
      return <BookingPreviewCard preorder={event.preorder} />;

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
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-action px-4 py-2.5 text-sm leading-relaxed text-white">
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
          <WaitingIndicator events={events} />
        ) : null}
      </div>
    </div>
  );
}
