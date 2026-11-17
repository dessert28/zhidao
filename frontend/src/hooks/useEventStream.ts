/* ------------------------------------------------------------------
 * useEventStream —— 手写 SSE 消费（docs/10 D5）
 *
 * 为什么不用 TanStack Query 包 SSE：
 *   Query 的心智模型是"请求-响应-缓存"，一次请求拿一个结果。
 *   SSE 是一次请求拿 N 个不同类型的事件，其中 token 只是其中一类。
 *   硬塞进去就变成"用 mutation 收流"，缓存的 stale/refetch 语义全失效。
 *
 * 为什么不用 EventSource：
 *   EventSource 只支持 GET，发不了请求体；也不能自定义 header。
 *   这里用 fetch + ReadableStream 手动解析帧。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '@shared/types/events';
import { composeRequestText } from '../lib/privacy/context';
import { clearChatHistory, getChatHistory, type ChatHistoryItem } from '../lib/api';

/** 服务端 enrich 后附加的字段，与 server/sse.ts 的 UiPayload 对应
 *
 * 用交叉类型而非 interface extends：AgentEvent 是可辨识联合，
 * 联合类型无法被 interface 继承，而且交叉后仍保留按 type 收窄的能力。
 */
export type StreamEvent = AgentEvent & {
  html?: string;
  props?: Record<string, unknown>;
};

export interface Turn {
  turnId: string;
  userText: string;
  events: StreamEvent[];
  /** 流式拼接的正文；token 事件追加到这里 */
  text: string;
  status: 'streaming' | 'done' | 'error';
}

export interface SendOptions {
  text: string;
  facts?: Record<string, unknown>;
  knownSlots?: Record<string, unknown>;
  round?: number;
  /**
   * 附在用户问题前的上下文（如健康档案摘要）。
   *
   * <p><b>它不是原样发送的</b>：和问题一样要过一遍脱敏，再拼进 text。
   * 原来这里是直接字符串拼接 —— 输入框那段遮过了，档案这段没有。
   * 见 lib/privacy/context.ts。
   */
  context?: string;
  lowScoreStreak?: number;
}

/** 一个 SSE 帧：event 名 + data 载荷 */
interface Frame {
  event: string;
  data: string;
}

/**
 * 增量解析 SSE 帧。
 * 返回 [完整帧列表, 剩余未闭合的缓冲]。
 *
 * 必须处理"一帧被切在两次 read 之间"的情况 ——
 * 这是手写 SSE 最容易出的 bug，网络一慢就复现。
 */
export function parseFrames(buffer: string): [Frame[], string] {
  const frames: Frame[] = [];
  const parts = buffer.split('\n\n');
  // 最后一个可能是半帧，留着和下次的数据拼接
  const rest = parts.pop() ?? '';

  for (const block of parts) {
    if (!block.trim()) continue;
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // 注释/心跳
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }

    if (dataLines.length > 0) {
      frames.push({ event, data: dataLines.join('\n') });
    }
  }

  return [frames, rest];
}

/* ============================ 会话标识 ============================ */

/**
 * 会话 id 存在 localStorage 而不是 sessionStorage。
 *
 * <p>这里和 `api.ts` 的 token 策略**故意相反**：token 用 sessionStorage
 * 是为了「关掉标签页就失效」；而会话 id 要解决的恰恰是「重开页面还能接上」，
 * 放在 sessionStorage 里一关标签页就换新 id，后端那份历史就永远读不回来了。
 *
 * <p>它本身不含任何患者信息（只是个 UUID），泄漏了也拼不出内容。
 */
const SESSION_KEY = 'zhidao:chat-session';

/** 读不到（隐私模式/配额满）时的内存兜底，保证本次页面生命周期内 id 稳定 */
let memorySessionId: string | null = null;

function newSessionId(): string {
  // crypto.randomUUID 需要安全上下文（https / localhost）。
  // 局域网 http 访问演示时会不可用，退化成时间戳+随机数 ——
  // 这里只要"不撞"就够，不需要密码学强度。
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * 取当前会话 id：优先沿用 localStorage 里存的，没有才新建。
 *
 * <p>返回值与写回是同一件事：调用方拿到的一定是"这之后刷新也能读到"的那个 id。
 * 分开写（先 get 再 set）会漏掉 set 失败的分支，于是发送用的 id 和存下的不一致。
 */
function resolveSessionId(): string {
  try {
    const saved = localStorage.getItem(SESSION_KEY);
    if (saved) return saved;
  } catch {
    /* localStorage 不可用，往下走内存兜底 */
  }

  if (memorySessionId) return memorySessionId;

  memorySessionId = newSessionId();
  try {
    localStorage.setItem(SESSION_KEY, memorySessionId);
  } catch {
    /* 存不了就只活这一次；比抛异常让整个对话挂掉好 */
  }
  return memorySessionId;
}

/**
 * 换一个新会话 id 并写回。
 *
 * <p>「重来」时用它：旧会话在后端已经删掉了，继续用旧 id 只会让
 * 后端对一个空会话反复建档。
 */
function rotateSessionId(): string {
  memorySessionId = newSessionId();
  try {
    localStorage.setItem(SESSION_KEY, memorySessionId);
  } catch {
    /* 同 resolveSessionId */
  }
  return memorySessionId;
}

/* ============================ 历史还原 ============================ */

/**
 * 把后端的历史消息还原成界面用的 `Turn[]`。
 *
 * <p>还原规则（两条都不能省）：
 * <ul>
 *   <li><b>配对</b>：同 `turnId` 的 user + assistant 合成一条 Turn。
 *       按 turnId 而不是按"相邻两条"，因为中间一旦缺了一条回复
 *       （流式中断、后端写库失败），按下标配对会整体错位，
 *       从此每一轮的问答都错行。</li>
 *   <li><b>孤儿 user 也要留</b>：只有 user 没有 assistant 的那一轮，
 *       说明回复没写成。丢掉它的后果是"刷新后我的问题消失了"，
 *       用户会以为发送失败，然后重复提问。</li>
 * </ul>
 *
 * <p>`events` 留空、`status` 直接 done：历史里只有纯文本，
 * 卡片、追问、预约预览这些结构化事件本来就是一次性的，
 * 重新编造出来的卡片比没有更糟（会给出过期的号源/楼层）。
 *
 * <p>顺序以后端返回的数组为准（约定是时间正序）。
 */
export function restoreTurns(items: ChatHistoryItem[]): Turn[] {
  const turns: Turn[] = [];
  /** turnId → 在 turns 里的下标。同一轮可能先来 user 再来 assistant */
  const index = new Map<string, number>();

  for (const item of items) {
    const at = index.get(item.turnId);

    if (item.role === 'user') {
      // 同一个 turnId 出现第二条 user：说明后端一轮里问了两次，
      // 保留最新的那句（界面上一轮只显示一个问题框）。
      if (at !== undefined) {
        const existing = turns[at];
        if (existing) turns[at] = { ...existing, userText: item.content };
        continue;
      }
      index.set(item.turnId, turns.length);
      turns.push({
        turnId: item.turnId,
        userText: item.content,
        events: [],
        text: '',
        status: 'done',
      });
      continue;
    }

    // assistant：有配对就填进那一轮，没有（历史被截断）就自己成一条
    if (at !== undefined) {
      const existing = turns[at];
      if (existing) turns[at] = { ...existing, text: item.content };
      continue;
    }
    index.set(item.turnId, turns.length);
    turns.push({
      turnId: item.turnId,
      userText: '',
      events: [],
      text: item.content,
      status: 'done',
    });
  }

  return turns;
}

export function useEventStream() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * 当前会话 id。
   *
   * <p>放 ref 而不是 state：它只在「发送」「重置」这两个命令式动作里被读，
   * 换 id 本身不需要渲染 —— 需要渲染的变化是 turns 清空，那由 setTurns 负责。
   * 放 state 反而会踩一个坑：fetch 的闭包里读到的是旧 id，
   * 于是「重来」之后的第一个问题仍然发进旧会话。
   *
   * <p>初始化时就在挂载里读，不在渲染期间读 localStorage：
   * 渲染必须纯净，StrictMode 下双次渲染会让「读到空就生成」跑两遍，
   * 生成两个 id 并互相覆盖。
   */
  const sessionIdRef = useRef<string | null>(null);

  /**
   * 挂载时：定住 sessionId，并拉一次历史把对话接上。
   *
   * <p>为什么历史失败**不提示**：这个页面在最常见的演示环境里
   * 后端根本没起。此时历史接口必然失败，但问诊对话本身完全可用
   * （`/api/chat` 是 BFF 自己处理的）。为了一条附属数据弹错误框，
   * 会让用户以为整个系统坏了 —— 静默降级成空白对话才是对的。
   *
   * <p>那个 cancelled 标记是必须的：StrictMode 会把 effect 跑两遍，
   * 第一次的请求回来时组件已经"卸载"过一轮，没有它就会把旧数据
   * 覆盖到用户新发的消息上。
   */
  useEffect(() => {
    sessionIdRef.current = resolveSessionId();

    let cancelled = false;
    void (async () => {
      const r = await getChatHistory(sessionIdRef.current ?? undefined);
      if (cancelled || !r.ok) return;

      // 已经有新消息了就合并，不能直接替换：用户可能在历史回来之前
      // 就已经发出了第一个问题（网慢时很容易发生），替换会把它抹掉。
      const restored = restoreTurns(r.data);
      setTurns((prev) => (prev.length > 0 ? [...restored, ...prev] : restored));
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 分诊会话状态 —— **跨轮保持**。
   *
   * <p>这是修复"记不住话"的核心。之前每轮 `send({ text })` 都不带状态，
   * 服务端每次从 `knownSlots: {} / round: 0` 开始，于是：
   * <ul>
   *   <li>用户答过「好几天了」，下一轮又问「多久了」</li>
   *   <li>「最多追问 3 轮」的熔断永远触发不了，因为它以为一直是第 1 轮</li>
   * </ul>
   *
   * <p>放 ref 不放 state：它只在发请求时被读取，不需要触发重渲染。
   * 放 state 会多一次 render，而且容易读到旧值。
   */
  const sessionRef = useRef<{ slots: Record<string, string | undefined>; round: number }>({
    slots: {},
    round: 0,
  });

  const send = useCallback(async (opts: SendOptions) => {
    const turnId = crypto.randomUUID();

    setBusy(true);
    setTurns((prev) => [
      ...prev,
      { turnId, userText: opts.text, events: [], text: '', status: 'streaming' },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    /** 幂等地往某一轮追加内容 */
    const patch = (fn: (t: Turn) => Turn) => {
      setTurns((prev) => prev.map((t) => (t.turnId === turnId ? fn(t) : t)));
    };

    try {
      /*
       * 上下文与问题分别脱敏后再拼接 —— 这是**唯一**组装请求体的地方。
       *
       * 放在这里而不是交给调用方：调用方只需要给"原始的档案摘要"，
       * 不需要知道还要脱敏。少一次"记得自己脱敏"的机会，就少一次漏掉的机会。
       */
      const { text: outboundText, question: outboundQuestion } = await composeRequestText(
        opts.context ?? '',
        opts.text,
      );

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          turnId,
          // 不再写死 session-1：那个常量让所有浏览器共用一个会话，
          // 刷新后前端还从 session-1 重新开始，而后端那边早就是另一份数据。
          sessionId: sessionIdRef.current ?? resolveSessionId(),
          text: outboundText,
          // 纯问题（脱敏后、不含健康档案），供服务端识别话题切换与情绪主诉
          question: outboundQuestion,
          facts: opts.facts,
          // 关键：把上一轮攒下的槽位与轮次带上，
          // 服务端才知道"这个槽位已经问过了"
          knownSlots: opts.knownSlots ?? sessionRef.current.slots,
          round: opts.round ?? sessionRef.current.round,
          lowScoreStreak: opts.lowScoreStreak,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const [frames, rest] = parseFrames(buffer);
        buffer = rest;

        for (const f of frames) {
          let evt: StreamEvent;
          try {
            evt = JSON.parse(f.data) as StreamEvent;
          } catch {
            continue; // 坏帧跳过，不让一条脏数据毁掉整轮
          }

          if (evt.type === 'done') {
            /*
             * 收下服务端回传的会话状态。
             *
             * 这一步决定"能不能记住上一轮说了什么"：
             * 不存，下一轮发出去的 knownSlots 还是空的，服务端就会重问。
             */
            if (evt.session) {
              sessionRef.current = {
                slots: evt.session.slots ?? {},
                round: evt.session.round ?? 0,
              };
            }
            patch((t) => ({ ...t, status: 'done' }));
            continue;
          }

          patch((t) => ({
            ...t,
            events: [...t.events, evt],
            text: evt.type === 'token' ? t.text + evt.text : t.text,
          }));
        }
      }

      patch((t) => (t.status === 'streaming' ? { ...t, status: 'done' } : t));
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      patch((t) => ({
        ...t,
        status: aborted ? 'done' : 'error',
        events: aborted
          ? t.events
          : [
              ...t.events,
              {
                type: 'caveat',
                text: '连接中断了，请检查网络后重试。如果反复失败，可能是服务未启动。',
              },
            ],
      }));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * 清空对话 —— 四件事必须同时做，否则「重来」是假的。
   *
   * <p>1. 掐掉在飞的流：不掐断的话，正在回来的 token 会往已经清空的
   *       turns 里 patch，出现一条没有问题的回答。
   * <p>2. 换 sessionId：旧 id 在后端已经删空，继续用只会在同一个
   *      会话里从头写起，下次刷新又能读到旧内容。
   * <p>3. 清服务端历史：只清本地 state 的话，刷新一下就全回来了 ——
   *      用户点「重来」的心愿就是从零开始。
   * <p>4. 清分诊会话状态（槽位 + 轮次）：这一条曾经漏掉，后果是气泡和
   *       历史都没了，但 `sessionRef` 里还留着上一轮采到的「肚子/三天/
   *       胀痛」。用户点完「重来」说一句全新的「我失恋了」，请求仍带着
   *       旧槽位、`round>0`，服务端判定"继续采集"，直接把旧症状和新主诉
   *       揉在一起 —— 界面清空了，AI 的记忆没清空，这是最隐蔽的一种
   *       「假重来」。必须把 ref 显式复位，才算真正从头开始。
   *
   * <p>清历史用 void 不 await：这是删除操作，等它没意义，
   * 而且后端没起时它会失败 —— 失败也不该拦住本地清空
   * （本地清空才是用户当下看得见的那一步）。
   */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    setTurns([]);

    // 第 4 步：分诊状态归零 —— 不复位这里，"重来"只清了表面
    sessionRef.current = { slots: {}, round: 0 };

    const old = sessionIdRef.current;
    sessionIdRef.current = rotateSessionId();
    if (old) void clearChatHistory(old);
  }, []);

  return { turns, busy, send, stop, reset };
}
