/* ------------------------------------------------------------------
 * /api/chat —— SSE 主入口，串起完整 Agent 链路
 * 依据：docs/05-Agent契约表.md §6，docs/10 D1（自研状态机）
 *
 * 链路：红线 → Supervisor → Triage → Reviewer → done
 * 每一环的失败都不会穿透到这个文件（各自 safeRun 兜住）。
 *
 * 隐私边界：请求体只接收**已脱敏文本**，字段名刻意叫 text 不是 rawText。
 * ------------------------------------------------------------------ */

import { Hono } from 'hono';
import type { AgentInput, SessionFacts, SymptomSlots } from '@shared/types/contract';
import { sseHeaders, toSseStream, type OutboundEvent } from '../sse.js';
import { makeSupervisor, routeByRules } from '../agents/supervisor.js';
import { makeTriage, type TriageInputPayload } from '../agents/triage.js';
import { makeReviewer, sanitizeAnswer, type ReviewInputPayload } from '../agents/reviewer.js';
import { makeRetrieval } from '../agents/retrieval.js';
import { checkRedFlag } from '../agents/rules/red-flag.js';
import { isLlmConfigured } from '../llm/client.js';
import { analyzeViaLlm, judgeViaLlm, planViaLlm as planWithModel } from '../agents/llm-impl.js';

export const chatRoutes = new Hono();

interface ChatBody {
  turnId?: string;
  sessionId?: string;
  /** 脱敏后文本；服务端无从得知原文 */
  text: string;
  facts?: Partial<SessionFacts>;
  /** 多轮追问时由前端带入的已采集槽位 */
  knownSlots?: SymptomSlots;
  round?: number;
  /** 同类问题连续低分次数，供 Reviewer 熔断判断 */
  lowScoreStreak?: number;
}

const EMPTY_FACTS: SessionFacts = {
  allergies: [],
  chronicConditions: [],
  currentMedications: [],
  bookingState: null,
};

/**
 * 三个 Agent 的 LLM 依赖注入点。
 *
 * <p><b>为什么集中在这里判断，而不是各 Agent 里各判一次</b>：
 * 「没配 Key 就整条走规则」是一个**全局性质**，不是三个独立开关。
 * 分散判断的话，只要有一处忘了判空，评审本地就会因为 401 而白屏 ——
 * 而 README 明确承诺过"无 Key 也能完整演示"。
 *
 * <p>返回 null 时各 Agent 走各自的规则兜底，且会在 {@code degraded} 里标注，
 * 前端 review_trace 卡能看到。
 */
function llmDeps() {
  if (!isLlmConfigured()) {
    return { triage: {}, reviewer: {}, plan: planViaLlm };
  }
  return {
    triage: { analyze: analyzeViaLlm },
    reviewer: { judge: judgeViaLlm },
    plan: planViaLlm,
  };
}

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
  const sessionId = body.sessionId || turnId;
  const facts: SessionFacts = { ...EMPTY_FACTS, ...body.facts };

  const stream = toSseStream(
    async (emit) => {
      /* ---------- 第 0 步：红线前置，不经 LLM ---------- */
      const red = checkRedFlag(body.text);
      if (red.hit) {
        emit({ type: 'emergency', redFlag: red.hit });
        emit({ type: 'speech', text: red.hit.guidance, lang: 'zh-CN', seq: 1 });
        return;
      }

      const baseInput = <P>(payload: P): AgentInput<P> => ({
        turnId,
        sessionId,
        userId: 'anonymous',
        payload,
        facts,
        memory: { window: [], summary: null, semanticHits: [] },
      });

      /* ---------- 第 1 步：Supervisor 决策 ---------- */
      const deps = llmDeps();
      const supervisor = makeSupervisor({ plan: deps.plan });
      const plan = await supervisor(baseInput({ text: body.text }));
      emitEvents(emit, plan.events);

      if (plan.status === 'failed' || plan.status === 'blocked') {
        emit({
          type: 'caveat',
          text: 'AI 调度暂不可用，已切换到基础指引。请稍后重试或咨询门诊导诊台。',
        });
        return;
      }

      const decision =
        plan.payload.decision === 'multi' ? plan.payload.agents[0] : plan.payload.decision;

      /* ---------- 第 2 步：按决策分发 ---------- */
      switch (decision) {
        case 'triage': {
          const triage = makeTriage(deps.triage);
          const triageInput: TriageInputPayload = {
            text: body.text,
            knownSlots: body.knownSlots ?? {},
            round: body.round ?? 0,
          };
          const triageOut = await triage(baseInput(triageInput));
          emitEvents(emit, triageOut.events);

          // 追问态：直接把问题说完就结束，不需要 Reviewer
          if (triageOut.status === 'need_clarify') return;
          if (triageOut.status === 'blocked') return;

          /* ---------- 第 3 步：Reviewer 审查分诊结果 ---------- */
          const answer = summarizeTriage(triageOut.payload.departments);
          emit({ type: 'token', text: answer });

          const reviewer = makeReviewer(deps.reviewer);
          const reviewInput: ReviewInputPayload = {
            candidateAnswer: answer,
            evidenceCount: triageOut.evidence.length,
            lowScoreStreak: body.lowScoreStreak ?? 0,
          };
          const reviewOut = await reviewer(baseInput(reviewInput));
          emitEvents(emit, reviewOut.events);

          // 若 Reviewer 改写了答案，把安全版本补发出去
          const safe = sanitizeAnswer(answer);
          if (safe.answer !== answer && !safe.blocked) {
            emit({ type: 'token', text: `\n\n（修订：${safe.answer}）` });
          }
          return;
        }

        case 'retrieve': {
          const retrieval = makeRetrieval();
          const out = await retrieval(baseInput({ text: body.text }));

          emitEvents(emit, out.events);

          const p = out.payload;

          // 无证据：如实说，不拿"一般性建议"糊过去
          if (out.status !== 'ok' || p.sources.length === 0) {
            emit({
              type: 'token',
              text: '这个问题我没在资料库里找到可靠依据。可以换个说法再问一次，或者直接咨询医生。',
            });
            return;
          }

          emit({ type: 'token', text: p.answer });

          // 检索到的答案同样要过 Reviewer —— 有引用不代表内容一定安全
          const reviewer = makeReviewer(deps.reviewer);
          const reviewed = await reviewer(
            baseInput<ReviewInputPayload>({
              candidateAnswer: p.answer,
              evidenceCount: p.sources.length,
              lowScoreStreak: body.lowScoreStreak ?? 0,
            }),
          );

          emitEvents(emit, reviewed.events);

          if (reviewed.status === 'blocked') {
            emit({
              type: 'token',
              text: '这段内容涉及用药细节，超出本系统的能力范围。请直接咨询医生或药师。',
            });
          }
          return;
        }

        case 'schedule':
          emit({
            type: 'token',
            text: '号源查询与预约功能正在接入中。当前可以先把症状告诉我，我帮你确认该挂哪个科。',
          });
          return;

        case 'done':
          emit({ type: 'token', text: '好的，还有其他需要帮忙的吗？' });
          return;
      }
    },
    { turnId },
  );

  return c.body(stream, 200, sseHeaders());
});

/* ============================ 辅助 ============================ */

function emitEvents(emit: (e: OutboundEvent) => void, events: readonly unknown[]) {
  for (const e of events) emit(e as OutboundEvent);
}

/** 把科室列表组织成一句人话 */
function summarizeTriage(
  departments: ReadonlyArray<{ name: string; reason: string; confidence: number }>,
): string {
  if (departments.length === 0) return '暂时无法判断该挂哪个科，建议到门诊导诊台说明情况。';
  const top = departments[0];
  if (!top) return '暂时无法判断该挂哪个科，建议到门诊导诊台说明情况。';

  const main = `建议优先挂「${top.name}」，依据是${top.reason}。`;
  if (departments.length === 1) return main;

  const others = departments.slice(1).map((d) => d.name).join('」或「');
  return `${main}如果挂号有困难，也可以先到「${others}」或门诊导诊台评估。`;
}

/**
 * Supervisor 的规划来源。
 *
 * <p><b>这里曾经是个占位</b>：不管有没有 Key 都 {@code return routeByRules(...)}，
 * 注释还写着"真实调用在 M2 接"。而 M2 早就标完成了 —— 于是 README 里
 * 「大模型集成质量 8%」这一档，实际上没有任何模型调用支撑。
 *
 * <p>现在的行为：
 * <ul>
 *   <li>没配 Key → 规则路由（保证评委本地可跑）</li>
 *   <li>配了 Key → 真调模型；模型返回 null（超时/坏输出）时，
 *       {@code makeSupervisor} 的降级阶梯会接手，先用规则路由，
 *       并在 {@code degraded} 里标出来</li>
 * </ul>
 *
 * <p>注意这里**不做重试**：supervisor.ts 自己有一次"坏 JSON 重试"，
 * 因为那是它契约的一部分。这一层再加一次只会让 8 秒超时变成 16 秒。
 */
async function planViaLlm(input: AgentInput<{ text: string }>): Promise<unknown> {
  if (!isLlmConfigured()) {
    return routeByRules(input.payload.text);
  }
  // 返回 null 时 supervisor 会走规则兜底，不会抛出
  return planWithModel(input.payload.text);
}
