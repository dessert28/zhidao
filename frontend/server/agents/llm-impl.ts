/* ------------------------------------------------------------------
 * 三个 Agent 的 LLM 实现 —— 契约与降级都在各自的 Agent 里，这里只管"问模型"
 * 依据：docs/05-Agent契约表.md §1 §2 §5
 *
 * 为什么要单独一个文件而不是塞进各 Agent：
 *   supervisor.ts / triage.ts / reviewer.ts 的设计前提是**可注入依赖**
 *   （`makeSupervisor({ plan })` 之类），这样单测里能塞假实现，
 *   不需要 mock 网络。把真实调用写在他们内部会破坏这一点。
 *   这个文件就是"生产环境注入的那一份"。
 *
 * 每个函数都必须满足：**失败返回 null，绝不抛**。
 * 对应的 Agent 收到 null 会走规则兜底，这是文档里承诺过的降级路径。
 * ------------------------------------------------------------------ */

import { z } from 'zod';
import type { Department, ReviewScores, SymptomSlots, SupervisorPayload } from '@shared/types/contract';
import { askObject } from '../llm/client.js';

/* ============================ 通用约束 ============================ */

/**
 * 所有 system prompt 共享的边界声明。
 *
 * 这段话不是免责声明，是**行为约束**：我们在 Prompt 层就把"医生才有权做的事"
 * 划出去，再在 Reviewer 里用规则表兜底。两层都要有 ——
 * 只靠 Prompt 是"相信模型会配合"，只靠规则是"等它说错再删"。
 */
const MEDICAL_BOUNDARY = `
你在一个面向中国患者的"导诊"系统里工作，不是医生，也不扮演医生。

绝对不做：
- 不下诊断结论（不说"你这是胃炎""确诊为糖尿病"）
- 不建议具体药名、剂量、停药或换药
- 不评价检查结果的好坏（"这个片子没问题"这类话不能说）
- 不做预后判断（"多久能好""会不会癌变"）

你只做：整理信息、给出该挂哪个科、提示该准备什么、提示何时该去医院。
语气用平实的中文，句子短，不用"亲""宝子"这类网络用语。
`.trim();

/* ============================ 1. Supervisor 规划 ============================ */

const PlanSchema = z.object({
  decision: z.enum(['triage', 'retrieve', 'schedule', 'multi', 'done']),
  agents: z.array(z.enum(['triage', 'retrieval', 'scheduler', 'reviewer'])).min(0).max(3),
  reason: z.string().min(1).max(200),
  requiresClarify: z.boolean(),
  missing: z.array(z.string()).max(5),
});

const SUPERVISOR_SYSTEM = `${MEDICAL_BOUNDARY}

你现在的角色是调度器 Supervisor：只判断"这句话该交给哪个子 Agent"，不做别的事。

decision 取值与判据：
- triage    ：用户在描述症状（"头晕""肚子疼"）→ 交给分诊，它负责问清部位/时长
- retrieve  ：用户在问知识（"空腹血糖高要注意什么""体检前要准备什么"）→ 交给循证检索
- schedule  ：用户在说挂号/预约/改约/排队 → 交给排程
- multi     ：确实需要两条链路（比如"我头晕，帮我挂个神经内科的号"）
- done      ：打招呼、感谢、与就医无关

多 Agent 时按 triage → retrieval → scheduler 的顺序写进 agents（有依赖，必须串行）。

reason 是给人看的一句话，说明你为什么这么分。**不要复述用户的话**，
要说依据（"这是症状描述而不是知识提问"）。`;

/**
 * 让模型给出路由计划。
 *
 * <p>返回值直接喂给 {@code makeSupervisor({ plan })}，它会拿 {@code parsePlan}
 * 再校验一遍 —— 模型即使返回了格式正确但语义越界的内容（比如 agents 里
 * 混进 supervisor），也会被拦下来。
 */
export async function planViaLlm(text: string): Promise<SupervisorPayload | null> {
  const out = await askObject({
    schema: PlanSchema,
    system: SUPERVISOR_SYSTEM,
    prompt: `用户这句话该交给谁处理？\n\n「${text}」`,
    temperature: 0.1,
  });
  return out as SupervisorPayload | null;
}

/* ============================ 2. Triage 抽取 ============================ */

const TriageSchema = z.object({
  slots: z.object({
    部位: z.string().optional(),
    时长: z.string().optional(),
    性质: z.string().optional(),
    诱因: z.string().optional(),
    伴随: z.string().optional(),
  }),
  departments: z
    .array(
      z.object({
        name: z.string().min(1),
        confidence: z.number().min(0).max(1),
        reason: z.string().min(1).max(80),
      }),
    )
    .min(0)
    .max(3),
});

const TRIAGE_SYSTEM = `${MEDICAL_BOUNDARY}

你现在的角色是分诊助手：从患者的口语描述里抽取症状槽位，并给出建议科室。

抽槽位的规矩：
- **只抽他真说过的，抽不到就留空**。不要为了填满而推测。
- 部位：确切的位置词（额头/后脑/左上腹/右脚踝）
- 时长：说"两天""半个月""三个月"；说"最近""一直""老是"时留空 ——
  这些词区分不出急性还是慢性，指向的科室完全不同，必须继续追问
- 性质：疼法（刺痛/胀痛/隐痛/绞痛/烧灼感）、或主要不适（咳嗽/发热/眩晕/乏力）
- 诱因：什么情况下加重或缓解（饭后/活动后/受凉后）
- 伴随：他还提到的其他不适（恶心/出汗/心慌）

科室的规矩：
- 从中文公立医院的常规科室里选，名字要标准（"心血管内科"而不是"心内科"）
- 最多 3 个，按把握从大到小排
- 每个科室必须给一句 reason，说明**是哪句话让你想到它**
- 症状不足以指向专科时，给"全科医学科"。**不许硬猜**
- confidence 要诚实：只有部位+时长+性质都清楚且指向明确时才能到 0.8 以上

**关于追问（重要）**：
- 只有当你**确实无法给出任何科室**时才让 slots 的关键项缺失。
- 如果症状已经能明确指向一个科室（例如"咳嗽两周有黄痰"→ 呼吸内科），
  **就不要再追问部位** —— 呼吸系统症状的"部位"本身就是呼吸道，
  再问"具体哪个位置"对用户是折磨。
- 判断标准是：**给出的科室是否已经可执行**。可执行就别问。`;

export interface TriageLlmInput {
  text: string;
  known: SymptomSlots;
  round: number;
}

/**
 * 让模型抽槽位 + 排科室。
 *
 * <p>注意把"上一轮已经采集到的槽位"一起传进去：模型需要知道
 * 哪些已经问过了，否则第 2、3 轮会重复追问同一个槽位。
 */
export async function analyzeViaLlm(
  input: TriageLlmInput,
): Promise<{ slots: SymptomSlots; departments: Department[] } | null> {
  const knownLine = Object.entries(input.known)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join('，');

  const out = await askObject({
    schema: TriageSchema,
    system: TRIAGE_SYSTEM,
    prompt: [
      `患者这一轮说：「${input.text}」`,
      knownLine ? `已经问到的槽位：${knownLine}（不要重复抽这几个，但可以在原值上补充细节）` : '这是第一轮，还没有任何槽位。',
      `这是第 ${input.round + 1} 次交互。`,
      '',
      '抽出这一轮能确定的槽位，并给出建议科室。',
    ].join('\n'),
    temperature: 0.1,
  });

  if (!out) return null;

  // 空对象 / 空数组都算"模型没给出有效内容"，交给规则兜底
  const hasSlots = Object.values(out.slots).some((v) => typeof v === 'string' && v.trim());
  if (!hasSlots && out.departments.length === 0) return null;

  return {
    slots: out.slots as SymptomSlots,
    departments: out.departments.map((d) => ({
      name: d.name,
      confidence: d.confidence,
      reason: d.reason,
    })),
  };
}

/* ============================ 3. Reviewer 打分 ============================ */

const JudgeSchema = z.object({
  safety: z.number().min(0).max(1),
  accuracy: z.number().min(0).max(1),
  completeness: z.number().min(0).max(1),
  groundedness: z.number().min(0).max(1),
  /** 一句话说明为什么扣分；全满分时填"无问题" */
  remark: z.string().max(200),
});

const JUDGE_SYSTEM = `${MEDICAL_BOUNDARY}

你现在的角色是质量审查员，给**别的模型写出的回答**打分（0 到 1）。

四个维度，各自独立的判据：

safety       有没有越界。出现诊断结论、具体药名剂量、停药换药建议、
             或者"不用去医院"这类弱化就医的话 —— 直接判 0。
             没越界给 1。这一项**不打折扣分**：越界就是越界。

accuracy     内容对不对。常识错误、把检查项目搞混、给出的科室明显不对，
             都要扣。拿不准的地方不算错。

completeness  有没有回答用户真正问的那件事。答非所问地绕开，扣到 0.4 以下。

groundedness  每句话都能溯源吗。凭空编的细节（具体数值、具体医院、具体政策）
             必须重罚。资料里没提的就说"资料里没有"，这是加分不是扣分。

打分要克制：这套分数会决定回答要不要被重做，虚高的分数等于放弃审查。`;

/**
 * LLM-as-judge。
 *
 * <p>注意：这里返回的分数**只是参考**。{@code reviewer.ts} 里的规则表
 * 优先级更高 —— safety 会取 rule 与 judge 的较小值，规则判 0 时
 * judge 打满分也没用。这是刻意的"规则优先于分数"。
 */
export async function judgeViaLlm(input: {
  answer: string;
  evidenceCount: number;
}): Promise<ReviewScores | null> {
  const out = await askObject({
    schema: JudgeSchema,
    system: JUDGE_SYSTEM,
    prompt: [
      `待审查的回答：\n「${input.answer}」`,
      '',
      `这条回答引用了 ${input.evidenceCount} 篇资料。`,
      '请给出四个维度的分数。',
    ].join('\n'),
    temperature: 0,
  });

  if (!out) return null;
  return {
    safety: out.safety,
    accuracy: out.accuracy,
    completeness: out.completeness,
    groundedness: out.groundedness,
  };
}
