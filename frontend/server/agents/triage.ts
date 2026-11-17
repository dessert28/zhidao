/* ------------------------------------------------------------------
 * Triage Agent —— 分诊与槽位采集
 * 依据：docs/05-Agent契约表.md §2
 *
 * 四条硬约束：
 *   1. 红线短路在 chat 入口已做，本 Agent 二次确认（防绕过）
 *   2. 槽位不足时最多追问 3 轮，之后必须给「信息不全」的兜底建议
 *   3. 置信度 < 0.5 时给 Top3 + 全科/导诊台，不许硬猜一个科
 *   4. LLM 失败 → 关键词规则表兜底，绝不 return 空科室
 * ------------------------------------------------------------------ */

import type {
  AgentInput,
  AgentOutput,
  Department,
  SymptomSlots,
  TriagePayload,
} from '@shared/types/contract';
import type { AgentEvent } from '@shared/types/events';
import { checkRedFlag } from './rules/red-flag.js';
import { emptyOutput, safeRun } from './safe-run.js';

/** 追问轮次上限（05 §2.3） */
export const MAX_CLARIFY_ROUNDS = 3;
/** 置信度下限，低于此值给 Top3 而非单一科室 */
export const MIN_CONFIDENCE = 0.5;
/**
 * 分诊的分析超时预算。
 *
 * <p>从 8000 调到 30000，理由与 {@code supervisor.ts} 的
 * SUPERVISOR_TIMEOUT_MS 一致：单次 LLM 往返实测 5.2–8.5 秒，
 * 8 秒预算基本没有余量，模型慢一点就降级成"只追问、不给科室"。
 *
 * <p>注意这不是"调大就没事"：分诊是整轮里最依赖模型的一步，
 * 它超时的表现是<b>问题问得比实际更少</b>（槽位没抽全），
 * 用户会以为系统没听懂 —— 比报错更难察觉。
 */
export const TRIAGE_TIMEOUT_MS = 30_000;

/* ============================ 槽位定义 ============================ */

/**
 * 五个必要槽位。顺序即追问优先级 —— 先问部位，因为没有部位什么都判断不了。
 * 关键：**不是所有槽位都必须填**。「部位 + 时长 + 性质」齐了就能给建议，
 * 诱因与伴随症状是加强项。全部要求会变成审问式体验。
 */
export const SLOT_KEYS = ['部位', '时长', '性质', '诱因', '伴随'] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];

/** 结够给出建议的最小槽位集 */
export const REQUIRED_SLOTS: SlotKey[] = ['部位', '时长'];

/** 槽位提取的正则表 —— 不依赖 LLM，作为兜底与预填 */
const SLOT_PATTERNS: Record<SlotKey, RegExp[]> = {
  部位: [
    /(头|额头|太阳穴|后脑|头顶|颈|脖子)/,
    /(胸|心口|乳房)/,
    /(腹|肚子|胃|上腹|下腹|肚脐)/,
    /(腰|背|肩|颈椎)/,
    /(手|脚|手指|脚趾|关节|膝盖|腿|胳膊|臂)/,
    /(牙|口腔|咽喉|嗓子|耳朵|鼻子|眼睛|眼)/,
    /(皮肤|全身)/,
  ],
  时长: [
    /(\d+|[一二两三四五六七八九十半几]+)\s*(分钟|小时|天|周|个?月|年)/,
    /(昨天|前天|今天|早上|晚上|刚才|持续|最近|一直|几天)/,
  ],
  性质: [
    /(疼|痛|酸|胀|麻|痒|烧灼|刺痛|钝痛|绞痛|隐痛|剧痛|闷|堵)/,
    /(咳嗽|发热|发烧|呕吐|腹泻|便秘|头晕|乏力|失眠|心慌|气短)/,
  ],
  诱因: [/(吃|喝|活动|运动|劳累|受凉|熬夜|情绪|按压|空腹|饭后)/],
  伴随: [/(伴|还有|同时|另外|加上).{0,12}(发热|呕吐|腹泻|头痛|乏力|出汗|恶心)/],
};

/**
 * 从一段文本抽取槽位。纯函数，不调 LLM。
 * 抽不到的槽位就是 undefined，交由追问逻辑处理。
 */
export function extractSlots(text: string): SymptomSlots {
  const slots: SymptomSlots = {};
  for (const key of SLOT_KEYS) {
    const patterns = SLOT_PATTERNS[key];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) {
        slots[key] = m[0];
        break;
      }
    }
  }
  return slots;
}

/** 合并多轮槽位，后到的非空值覆盖先前的 */
export function mergeSlots(base: SymptomSlots, next: SymptomSlots): SymptomSlots {
  const out: SymptomSlots = { ...base };
  for (const [k, v] of Object.entries(next)) {
    if (v) out[k] = v;
  }
  return out;
}

/**
 * 症状本身就指明部位的词。
 *
 * <p>为什么需要这张表：`REQUIRED_SLOTS` 无条件要求「部位」，
 * 但有些症状的**部位是自带的** —— 说「咳嗽」就是呼吸道，
 * 说「尿频」就是泌尿系统。此时再问「具体是哪个位置不舒服？」
 * 是纯粹的折磨，用户实测反馈过这一点。
 *
 * <p>判据：这些词单独出现时，部位已无追问价值。
 * 注意「疼」「痛」「不舒服」不在表里 —— 它们恰恰是最需要问部位的。
 */
const SELF_LOCATED_SYMPTOMS =
  /(咳嗽|咳痰|黄痰|白痰|气喘|哮喘|气短|呼吸困难|流涕|鼻塞|咽痛|喉咙痛|耳鸣|视力|尿频|尿急|尿痛|月经|痛经|白带|皮疹|瘙痒|腹泻|拉肚子|便秘|反酸|烧心|心慌|心悸|胸闷)/;

/**
 * 检验指标类提问 —— **既不需要部位，也不需要时长**。
 *
 * <p>与上面那张表的区别：症状是"身体某处不舒服"，指标是"化验单上某个数值"。
 * 前者问部位合理，问时长也合理；后者两者都无从谈起 ——
 * 血糖、血脂、转氨酶没有"位置"，时长就是化验单上的日期，用户来问
 * 通常是想知道"这个数值要不要紧、该挂哪个科"。
 *
 * <p>实测缺陷（2026-11-15）：问「血糖高要去哪个科」时，系统回
 * 「具体是哪个位置不舒服？比如额头、胸口、肚子左边？」——
 * 用户没法回答，因为在问一个不存在的东西。这比"多问一句"更糟：
 * 它暴露了系统没理解问题。
 *
 * <p>判据要**保守**：只有明确指向检验指标时才短路。
 * 「血糖高还头晕」这类混合表述不在此列 —— 那种情况仍然需要问部位。
 */
const LAB_INDICATOR_QUERY =
  /(血糖|血脂|胆固醇|甘油三酯|低密度脂蛋白|转氨酶|肌酐|尿酸|糖化血红蛋白|甲功|甲状腺功能|白细胞|血红蛋白|血常规|尿常规|指标|化验|体检报告|检查结果|报告单)/;

/**
 * 混合表述的排除词：出现这些说明用户在描述身体不适，
 * 即使同时提到指标，也应当按症状处理（要问部位）。
 */
const BODY_COMPLAINT =
  /(疼|痛|闷|不舒服|难受|乏力|头晕|恶心|呕吐|发热|发烧|咳|喘|麻|肿|痒)/;

/** 还缺哪些最小必要槽位 */
export function missingSlots(slots: SymptomSlots, text = ''): SlotKey[] {
  // 部位隐含在症状里时，不再把「部位」当成必填
  const hay = `${text} ${slots['性质'] ?? ''}`;
  const locationImplied = SELF_LOCATED_SYMPTOMS.test(hay);

  /*
   * 纯指标查询：不问部位，也不问时长。
   *
   * 要求同时满足两条才短路：
   *   ① 命中指标词
   *   ② 没有任何身体不适描述
   * 这样「血糖高还头晕」仍会正常追问部位，不会因为提到指标就跳过采集。
   */
  const isLabQuery = LAB_INDICATOR_QUERY.test(hay) && !BODY_COMPLAINT.test(hay);

  return REQUIRED_SLOTS.filter((k) => {
    if (k === '部位' && locationImplied) return false;
    if (k === '部位' && isLabQuery) return false;
    if (k === '时长' && isLabQuery) return false;
    const v = slots[k];
    if (!v) return true;
    // 「最近」「一直」是模糊表述，不等于采集到了时长 —— 几天还是几年，
    // 对分诊结论影响很大（急性 vs 慢性指向不同科室），必须追问。
    if (k === '时长' && VAGUE_TIME.test(v)) return true;
    return false;
  });
}

/** 模糊时间表述：占位但不算有效值 */
const VAGUE_TIME = /^(最近|一直|这几天|前几天|平时|偶尔|有时|时不时|老是|总是)$/;

/* ============================ 追问话术 ============================ */

/**
 * 每个槽位的追问话术。**刻意口语化、给例子** —— "请描述疼痛性质"
 * 是医生的说法，患者答不上来；"是针扎一样疼，还是闷闷的胀痛？"才答得上。
 */
const QUESTIONS: Record<SlotKey, string> = {
  部位: '具体是哪个位置不舒服？比如额头、胸口、肚子左边？',
  时长: '这个情况大概多久了？几个小时，还是好几天了？',
  性质: '是怎么个难受法？针扎一样疼、闷闷地胀，还是酸麻？',
  诱因: '有没有什么情况下会加重或缓解？比如吃完饭、活动后？',
  伴随: '除了这个，还有别的不舒服吗？比如发热、恶心、乏力？',
};

export function buildQuestion(missing: SlotKey[]): string {
  if (missing.length === 0) return '';
  // 一次最多问两个，避免审问感
  const ask = missing.slice(0, 2).map((k) => QUESTIONS[k]).join('\n');
  return ask;
}

/* ============================ 科室规则表 ============================ */

interface DeptRule {
  keywords: RegExp;
  departments: string[];
  reason: string;
}

/**
 * 关键词 → 科室。LLM 不可用时的兜底，也是置信度计算的先验。
 * 保守原则：能对上就给，对不上给全科。
 */
const DEPT_RULES: DeptRule[] = [
  // 注意：中文口语里「胸口闷」「胸部发闷」都常见，不能只匹配「胸闷」这个连写词
  { keywords: /(胸.{0,2}(痛|闷|疼|紧|压)|心慌|心悸|心跳快|血压高)/, departments: ['心血管内科'], reason: '症状指向心血管系统' },
  { keywords: /(咳|嗽|痰|喘|呼吸困难|气短|气促|肺)/, departments: ['呼吸内科'], reason: '症状指向呼吸系统' },
  { keywords: /(胃|腹|肚子|肚脐|恶心|呕吐|腹泻|拉肚子|便秘|消化|反酸)/, departments: ['消化内科'], reason: '症状指向消化系统' },
  { keywords: /(头.{0,2}(晕|痛|疼|胀|沉)|失眠|手麻|抽搐|记忆|偏头痛)/, departments: ['神经内科'], reason: '症状指向神经系统' },
  { keywords: /(血糖|糖尿|口渴|多尿|甲状腺|体重下降|甲亢|甲减)/, departments: ['内分泌科'], reason: '症状指向内分泌代谢' },
  { keywords: /(关节|腰|颈|肩|膝|骨|扭伤|颈椎|腰椎)/, departments: ['骨科'], reason: '症状指向骨关节' },
  { keywords: /(皮肤|疹|痒|斑|过敏|起疙瘩)/, departments: ['皮肤科'], reason: '症状指向皮肤' },
  { keywords: /(尿|肾|排尿|水肿|尿频|尿急)/, departments: ['肾内科'], reason: '症状指向泌尿系统' },
  { keywords: /(月经|白带|妇科|怀孕|痛经)/, departments: ['妇科'], reason: '症状指向妇科' },
  { keywords: /(牙|口腔|牙龈|蛀牙)/, departments: ['口腔科'], reason: '症状指向口腔' },
  { keywords: /(眼|视力|看不清|模糊|流泪)/, departments: ['眼科'], reason: '症状指向眼科' },
  { keywords: /(嗓子|咽喉|喉咙|耳朵|鼻|耳鸣|流鼻涕)/, departments: ['耳鼻咽喉科'], reason: '症状指向耳鼻咽喉' },
];

/** 兜底科室：分不出时建议这两个，而不是硬猜 */
export const FALLBACK_DEPARTMENTS = ['全科医学科', '门诊导诊台'];

export function guessDepartments(slots: SymptomSlots, text: string): Department[] {
  const hay = `${text} ${Object.values(slots).filter(Boolean).join(' ')}`;
  const hits: Department[] = [];

  for (const rule of DEPT_RULES) {
    if (rule.keywords.test(hay)) {
      for (const name of rule.departments) {
        if (!hits.some((d) => d.name === name)) {
          hits.push({ name, confidence: 0.72, reason: rule.reason });
        }
      }
    }
  }

  if (hits.length === 0) {
    return FALLBACK_DEPARTMENTS.map((name) => ({
      name,
      confidence: 0.4,
      reason: '症状描述尚不足以明确指向某个专科，建议先到全科或导诊台评估',
    }));
  }
  return hits.slice(0, 3);
}

/* ============================ 置信度 ============================ */

/**
 * 置信度不是玄学，是三个可解释因子的加权：
 *   槽位完整度 0.5 + 科室命中强度 0.3 + 描述长度 0.2
 * 答辩时可以直接把这行公式讲出来。
 */
export function computeConfidence(slots: SymptomSlots, depts: Department[]): number {
  const filled = REQUIRED_SLOTS.filter((k) => slots[k]).length / REQUIRED_SLOTS.length;
  const optionalFilled = SLOT_KEYS.filter((k) => slots[k]).length / SLOT_KEYS.length;
  const slotScore = filled * 0.5 + optionalFilled * 0.15;

  const top = depts[0]?.confidence ?? 0;
  const deptScore = top * 0.3;

  const descScore = slots['性质'] ? 0.05 : 0;
  const raw = slotScore + deptScore + descScore;

  return Math.max(0, Math.min(1, Number(raw.toFixed(2))));
}

/* ============================ 主处理 ============================ */

export interface TriageDeps {
  /**
   * 用 LLM 抽取槽位并排序科室。可选 —— 不提供则纯规则。
   * 返回 null 表示模型输出不可用，触发规则兜底。
   */
  analyze?: (input: {
    text: string;
    known: SymptomSlots;
    round: number;
  }) => Promise<{ slots: SymptomSlots; departments: Department[] } | null>;
}

export interface TriageInputPayload {
  text: string;
  /** 上一轮已采集的槽位（由会话状态带入） */
  knownSlots?: SymptomSlots;
  /** 当前是第几轮追问，从 0 开始 */
  round?: number;
}

export function makeTriage(deps: TriageDeps = {}) {
  async function handle(
    input: AgentInput<TriageInputPayload>,
  ): Promise<AgentOutput<TriagePayload>> {
    const { text, knownSlots = {}, round = 0 } = input.payload;
    const events: AgentEvent[] = [];

    /* 二次红线确认：即使入口漏了，这里也拦住 */
    const red = checkRedFlag(text);
    if (red.hit) {
      events.push({ type: 'emergency', redFlag: red.hit });
      return {
        status: 'blocked',
        payload: {
          departments: [],
          redFlag: red.hit,
          collectedSymptoms: knownSlots,
          nextQuestion: null,
        },
        confidence: 1,
        evidence: [],
        events,
      };
    }

    /* 槽位合并：规则抽取 + 可选 LLM 抽取 */
    const ruleSlots = extractSlots(text);
    let slots = mergeSlots(knownSlots, ruleSlots);
    let departments: Department[] = [];
    let usedLlm = false;

    if (deps.analyze) {
      try {
        const out = await withGuard(deps.analyze({ text, known: slots, round }));
        if (out) {
          slots = mergeSlots(slots, out.slots);
          departments = out.departments;
          usedLlm = true;
        }
      } catch {
        // LLM 失败不阻塞：下面的规则表会处理
        usedLlm = false;
      }
    }

    if (departments.length === 0) {
      departments = guessDepartments(slots, text);
    }

    // 传原文进去：部位是否隐含在症状里（如「咳嗽」自带呼吸道）要据此判断
    const missing = missingSlots(slots, text);
    const confidence = computeConfidence(slots, departments);

    /* 低置信：给 Top3 + 兜底，不硬猜 */
    if (confidence < MIN_CONFIDENCE && departments.length === 1) {
      const extra = FALLBACK_DEPARTMENTS
        // 兜底项不能和已有的重复。
        // 实测缺陷：模型自己给了「全科医学科」，兜底又追加一个，
        // 卡片上就出现两条一模一样的「全科医学科」，用户会以为系统坏了。
        .filter((name) => !departments.some((d) => d.name === name))
        .map((name) => ({
          name,
          confidence: 0.4,
          reason: '作为备选，建议先到导诊台确认',
        }));
      departments = [...departments, ...extra].slice(0, 3);
    }

    /*
     * 最终去重（防御性）：模型可能自己就返回了两个同名科室
     * （实测见过「全科医学科」重复两次）。按名字去重保留第一个 ——
     * 前面那个通常是更具体的那个。
     */
    {
      const seen = new Set<string>();
      departments = departments.filter((d) => {
        if (seen.has(d.name)) return false;
        seen.add(d.name);
        return true;
      });
    }

    /* 还缺必要槽位，且未达追问上限 → 追问 */
    if (missing.length > 0 && round < MAX_CLARIFY_ROUNDS) {
      const question = buildQuestion(missing);
      events.push({ type: 'clarify', question, missing });

      return {
        status: 'need_clarify',
        payload: {
          departments,
          redFlag: null,
          collectedSymptoms: slots,
          nextQuestion: question,
        },
        confidence,
        evidence: [],
        events,
        ...(usedLlm ? {} : { degraded: degrade('槽位与科室由本地规则表推算', 'rule-table') }),
      };
    }

    /* 追问到上限仍未集齐 → 明确说信息不全，给保守建议 */
    if (missing.length > 0 && round >= MAX_CLARIFY_ROUNDS) {
      events.push({
        type: 'caveat',
        text: `已询问 ${MAX_CLARIFY_ROUNDS} 轮，症状信息仍不完整。以下建议仅供参考，建议直接到门诊导诊台说明情况。`,
      });
    }

    events.push({ type: 'department_card', departments });

    return {
      status: 'ok',
      payload: {
        departments,
        redFlag: null,
        collectedSymptoms: slots,
        nextQuestion: null,
      },
      confidence,
      evidence: departments.map((d) => ({
        type: 'rule' as const,
        id: `dept:${d.name}`,
        span: [0, d.reason.length] as [number, number],
      })),
      events,
      ...(usedLlm ? {} : { degraded: degrade('科室排序由关键词规则表给出', 'rule-table') }),
    };
  }

  return (input: AgentInput<TriageInputPayload>) =>
    safeRun(handle, input, {
      agent: 'triage',
      timeoutMs: TRIAGE_TIMEOUT_MS,
      fallback: {
        ...emptyOutput<TriagePayload>({
          departments: guessDepartments(
            input.payload.knownSlots ?? {},
            input.payload.text,
          ),
          redFlag: null,
          collectedSymptoms: input.payload.knownSlots ?? {},
          nextQuestion: null,
        }),
        events: [
          {
            type: 'caveat',
            text: '分诊服务暂时不可用，已根据关键词给出基础建议，请以门诊导诊台意见为准。',
          },
        ],
      },
    });
}

function degrade(reason: string, fallback: string) {
  return { stage: 'triage', reason, fallback };
}

/** 单个 LLM 调用加超时，防止拖垮整个 Agent */
function withGuard<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('llm timeout')), ms)),
  ]);
}
