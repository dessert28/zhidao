/* ------------------------------------------------------------------
 * /api/chat —— SSE 主入口
 * 依据：docs/05-Agent契约表.md §6，docs/10 D1（自研状态机）
 *
 * 请求体只接收**已脱敏文本**。原文永远留在浏览器 IndexedDB。
 * 这里是隐私边界在服务端的落地检查点：字段名刻意叫 text 而不是 rawText。
 * ------------------------------------------------------------------ */

import { Hono } from 'hono';
import type { AgentInput, SessionFacts } from '@shared/types/contract';
import { sseHeaders, toSseStream, type OutboundEvent } from '../sse.js';
import { makeSupervisor, routeByRules } from '../agents/supervisor.js';
import { checkRedFlag } from '../agents/rules/red-flag.js';

export const chatRoutes = new Hono();

interface ChatBody {
  turnId: string;
  sessionId: string;
  /** 脱敏后文本；服务端无从得知原文 */
  text: string;
  facts?: Partial<SessionFacts>;
}

const EMPTY_FACTS: SessionFacts = {
  allergies: [],
  chronicConditions: [],
  currentMedications: [],
  bookingState: null,
};

chatRoutes.post('/', async (c) => {
  let body: ChatBody;
  try {
    body = await c.req.json<ChatBody>();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  if (!body?.text || typeof body.text !== 'string') {
    return c.json({ error: 'text_required' }, 400);
  }
  const turnId = body.turnId || crypto.randomUUID();
  const facts: SessionFacts = { ...EMPTY_FACTS, ...body.facts };

  const stream = toSseStream(
    async (emit) => {
      /* 第 0 步：红线前置 —— 不经 LLM，命中即短路（05 §2.4） */
      const red = checkRedFlag(body.text);
      if (red.hit) {
        emit({ type: 'emergency', redFlag: red.hit });
        // 急症场景不继续分诊，也不给任何"建议挂号"的话术
        emit({
          type: 'speech',
          text: red.hit.guidance,
          lang: 'zh-CN',
          seq: 1,
        });
        return; // 交由 toSseStream 补 done
      }

      /* 第 1 步：Supervisor 决策 */
      const supervisor = makeSupervisor({ plan: planViaLlm });
      const input: AgentInput<{ text: string }> = {
        turnId,
        sessionId: body.sessionId ?? turnId,
        userId: 'anonymous',
        payload: { text: body.text },
        facts,
        memory: { window: [], summary: null, semanticHits: [] },
      };

      const plan = await supervisor(input);
      emitEvents(emit, plan.events);

      /* 第 2 步：按决策分发。省赛版本只接 Triage，其余走占位说明 */
      if (plan.status === 'failed') {
        emit({
          type: 'caveat',
          text: 'AI 调度暂不可用，已切换到基础指引。请稍后重试。',
        });
        return;
      }

      const decision = plan.payload.decision === 'multi' ? plan.payload.agents[0] : plan.payload.decision;
      switch (decision) {
        case 'triage':
          emit({ type: 'token', text: '我先了解一下你的情况，帮助你找对科室。' });
          emit({
            type: 'clarify',
            question: '不舒服的部位在哪里？大概持续多久了？',
            missing: ['部位', '时长'],
          });
          break;
        case 'retrieve':
          emit({ type: 'token', text: '我查一下相关资料，请稍等。' });
          break;
        case 'schedule':
          emit({ type: 'token', text: '好，我帮你看看号源。' });
          break;
        case 'done':
          emit({ type: 'token', text: '好的。' });
          break;
      }
    },
    { turnId },
  );

  return c.body(stream, 200, sseHeaders());
});

function emitEvents(emit: (e: OutboundEvent) => void, events: readonly unknown[]) {
  for (const e of events) emit(e as OutboundEvent);
}

/**
 * LLM 规划。未配置密钥时直接走规则路由 —— 这是刻意设计：
 * 无密钥也能跑通主链路，评委本地起项目不会白屏。
 */
async function planViaLlm(input: AgentInput<{ text: string }>): Promise<unknown> {
  if (!process.env.LLM_API_KEY) {
    return routeByRules(input.payload.text);
  }
  // 真实调用在 M2 接（ai SDK streamObject）；M1 先复用规则路由保证可演示
  return routeByRules(input.payload.text);
}
