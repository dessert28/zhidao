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
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { BookingPreview } from '@shared/types/contract';
import { createBooking, ensureLogin } from '../lib/api';
import { HospitalNav } from './HospitalNav';
import { WaitingIndicator } from './WaitingIndicator';

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

/**
 * 预约预览卡 —— 三段式里「在院内」的入口。
 *
 * <p><b>为什么这一张必须是客户端组件</b>：它有真实副作用（下单）。
 * 服务端 renderToString 出来的 HTML 没有事件绑定，点了没反应。
 *
 * <p><b>为什么默认不自动下单</b>：挂号是占号的操作，
 * AI 替用户确认会让"我没让你挂"变成无法回滚的事故。
 * 所以这里只展示，确认按钮必须由人点。
 */
function BookingPreviewCard({ preorder }: { preorder: BookingPreview }) {
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const confirm = async () => {
    setStatus('submitting');
    setMessage('');
    let r = await createBooking({
      hospitalCode: preorder.hospitalCode,
      department: preorder.department,
      visitTime: preorder.slot,
    });
    /*
     * 401 自动重登一次。
     *
     * 实测场景：后端重启后 JWT 密钥重新生成，页面里存的 token 全部作废。
     * 之前直接显示「登录已失效，请刷新页面后重试」——
     * 但 token 已经被 request() 清掉了，此刻 ensureLogin 就能拿到新 token，
     * 让用户手动刷新等于把能自动解决的事推给用户。
     *
     * 只重试一次：如果重登后再失败，那是别的问题，别掩盖。
     */
    if (!r.ok && r.failure.kind === 'unauthorized') {
      const re = await ensureLogin();
      if (re.ok) {
        r = await createBooking({
          hospitalCode: preorder.hospitalCode,
          department: preorder.department,
          visitTime: preorder.slot,
        });
      }
    }
    if (r.ok) {
      setStatus('done');
      setMessage('已预约成功，可在「我的病历」查看。');
    } else {
      setStatus('error');
      setMessage(
        r.failure.kind === 'unreachable'
          ? '预约服务不可用，请到医院自助机或窗口办理。'
          : r.failure.kind === 'unauthorized'
            ? '登录已失效，请刷新页面后重试。'
            : r.failure.message,
      );
    }
  };

  return (
    <div className="animate-fade-up rounded-xl border border-brand-200 bg-white">
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

        {status === 'done' ? (
          <>
            <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-700">{message}</p>
            {/*
              预约成功后给一个**能回去的入口**，而不是把导航直接铺在对话里。

              对话里的卡片刷新就没了 —— 而患者真正的使用时刻是
              "明天早上站在门诊楼里"，那时对话早就不在了。
              所以这一步把人引到独立的「到院」页，那里同样的信息
              常驻、可刷新、手机上还有 tab。

              保留一小段导航摘要是因为"约完马上走"也有意义：
              当天来的人此刻就需要知道去哪个楼。
            */}
            <div className="mt-3">
              <Link
                to="/visit"
                className="inline-flex items-center gap-1 rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-medium text-white"
              >
                到院后看怎么走 →
              </Link>
            </div>
            <div className="mt-4 border-t border-brand-100 pt-4">
              <HospitalNav
                hospitalCode={preorder.hospitalCode}
                department={preorder.department}
                visitTime={preorder.slot}
              />
            </div>
          </>
        ) : (
          <>
            {status === 'error' ? (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {message}
              </p>
            ) : null}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={confirm}
                disabled={status === 'submitting'}
                className="h-9 rounded-lg bg-brand-700 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-800 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {status === 'submitting' ? '正在预约…' : '确认挂号'}
              </button>
              <span className="text-xs leading-relaxed text-gray-400">
                确认后会占用该号源，请确定时间合适再点
              </span>
            </div>
          </>
        )}
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
          <WaitingIndicator events={events} />
        ) : null}
      </div>
    </div>
  );
}
