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

  /**
   * 分诊会话状态。
   *
   * <p><b>从请求里恢复，在本轮里就地更新，结束时随 done 回给前端。</b>
   *
   * <p>三条都要做到，缺任何一条都会复现"记不住话"：
   * <ul>
   *   <li>读：`body.knownSlots` / `body.round` —— 不读就是每轮从零开始</li>
   *   <li>写：本轮 Triage 采集到的槽位要合并进来 —— 不写则下一轮仍缺</li>
   *   <li>回：done 里带上 —— 不回则前端没东西可带</li>
   * </ul>
   */
  const session: { slots: SymptomSlots; round: number } = {
    slots: { ...(body.knownSlots ?? {}) },
    round: body.round ?? 0,
  };

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

      /*
       * 追问连续性：上一轮停在「需要补充」时，本轮**不该重新决策**。
       *
       * 为什么必须短路：用户正在回答追问，回复往往很短（「嗯」「好几天了」
       * 「胸」），单独看这些句子根本不构成症状描述。让 Supervisor 重新判断，
       * 它会得到荒谬的结论 —— 实测「嗯」被判成 done，
       * 于是 AI 回了句「还有其他需要帮忙的吗？」，把正在问诊的用户赶走。
       *
       * 判据不用猜：`round > 0` 就说明上一轮问过、用户在答。
       * 这个状态是前端带回来的（done 事件里的 session）。
       */
      const continuingClarify = session.round > 0;

      let decision: string;
      if (continuingClarify) {
        // 仍然发一条 plan，让前端知道"正在继续采集"，但不问模型
        emit({
          type: 'plan',
          decision: 'triage',
          reason: `继续采集症状信息（第 ${session.round + 1} 轮）`,
          agents: ['triage'],
        });
        decision = 'triage';
      } else {
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
        decision =
          plan.payload.decision === 'multi'
            ? // multi 时取第一个子 Agent；数组可能为空（模型给了 multi 但没给 agents），
              // 这种退化情况按 triage 处理：宁可多问一句，不要答错
              (plan.payload.agents[0] ?? 'triage')
            : plan.payload.decision;
      }

      /* ---------- 第 2 步：按决策分发 ---------- */
      switch (decision) {
        case 'triage': {
          const triage = makeTriage(deps.triage);
          const triageInput: TriageInputPayload = {
            text: body.text,
            // 用会话里累积的槽位，而不是请求里那份原样传一次 ——
            // 后者在同一轮内部就不一致了
            knownSlots: session.slots,
            round: session.round,
          };
          const triageOut = await triage(baseInput(triageInput));
          emitEvents(emit, triageOut.events);

          /*
           * 把本轮抽到的槽位并回会话。
           *
           * 这一步必须做，否则下一轮还是缺 —— 这是"问了又问"的直接原因。
           *
           * 但要过滤模型返回的**占位词**：实测模型会说「部位=未提及」
           * 「时长=不详」「诱因=无」，如果不挡，系统就把这些当成已采集，
           * 于是跳过那个槽位不再追问 —— 用户明明没说哪里不舒服，
           * 系统却直接给科室了。这是比"重复追问"更危险的一类错误：
           * 前者烦人，后者给错结论。
           */
          for (const [k, v] of Object.entries(triageOut.payload.collectedSymptoms ?? {})) {
            if (typeof v !== 'string') continue;
            const val = v.trim();
            if (!val) continue;
            if (isPlaceholderValue(val)) continue;
            session.slots[k] = val;
          }

          // 追问态：轮次 +1 再返回，让下一轮知道已经问过几次
          if (triageOut.status === 'need_clarify') {
            session.round += 1;
            return;
          }
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
    {
      turnId,
      /*
       * 把本轮结束时的分诊会话状态交给 done 事件。
       *
       * 为什么用回调读 `session` 而不是在 producer 里 emit：
       * done 只该由 sse.ts 发一次（正常/异常两条路径都要带状态），
       * 这里只负责"把当前状态拿出来"。
       *
       * 为什么必须有这个：没有它，每轮都是独立会话 ——
       * 用户答过"好几天了"，下一轮系统仍然问"多久了"。
       * 实测过，用户原话是"你问过我了"。
       */
      getSession: () => session,
    },
  );

  return c.body(stream, 200, sseHeaders());
});

/* ============================ 辅助 ============================ */

/**
 * 判断模型给的槽位值是不是"占位词"。
 *
 * <p>模型被要求"抽不到就留空"，但它经常不听话，改用这些词填空：
 * <pre>
 *   部位 = 未提及 / 不详 / 无 / 未知 / 未描述 / N/A
 *   时长 = 不详
 * </pre>
 *
 * <p>如果不挡，「部位=未提及」会被当成已采集，系统就跳过追问部位 ——
 * 用户从没说过哪里疼，系统却直接给了科室。这比重复追问危险得多。
 *
 * <p><b>判定必须保守</b>：宁可让系统多问一句，也不能把真实信息当占位词丢掉。
 * 所以只匹配整串就是这些词的情况，不做包含匹配 ——
 * 「不是未提及，是胸口」这种真实回答不能被误伤。
 */
function isPlaceholderValue(v: string): boolean {
  const s = v.trim().replace(/[。，,.、\s]/g, '');
  if (!s) return true;
  return /^(未提及|未说明|未明确|未描述|未知|不详|不清楚|不确定|无|没有|暂无|none|null|n\/a|na|unknown|-{1,2})$/i.test(
    s,
  );
}

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
