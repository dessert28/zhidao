/* ------------------------------------------------------------------
 * Reviewer Agent —— 四维自评 + 交叉检查 + 强制兜底
 * 依据：docs/05-Agent契约表.md §5
 *
 * 核心设计原则（这条比代码本身重要）：
 *   **规则优先于分数。**
 *   LLM-as-judge 给的分只是参考，安全维度由确定性规则表直接判定。
 *   「建议吃药」这种输出，无论 judge 打多高都必须拦截。
 *
 * 第二条：
 *   **失败要保守，不是放过。**
 *   Judge 挂了 → 跳过自评，但强制追加免责声明。
 *   宁可不给答案，也不给一个没被检查过的答案。
 * ------------------------------------------------------------------ */

import type {
  AgentInput,
  AgentOutput,
  ReviewIssue,
  ReviewScores,
  ReviewerPayload,
  SessionFacts,
} from '@shared/types/contract';
import type { AgentEvent } from '@shared/types/events';
import { recheckAnswer } from './rules/red-flag.js';
import { emptyOutput, safeRun } from './safe-run.js';

/**
 * 自检（Reviewer）的超时预算。
 *
 * <p>从 8000 调到 30000，理由同 supervisor / triage。
 *
 * <p>Reviewer 超时的后果和别处不一样，值得单独说清楚：
 * 它负责四维打分（安全/准确/完整/依据）与改写。<b>超时不会让回答消失</b>
 * （答案已经在前面发出去了），而是让那次自检变成"没审过就放行"。
 * 所以界面上看不到错误，但质量保障少了一道 ——
 * 这类静默降级必须有足够余量，否则等于自检形同虚设。
 */
export const REVIEW_TIMEOUT_MS = 30_000;

/** 四维默认阈值，可被 input 覆盖 */
export const DEFAULT_THRESHOLDS: ReviewScores = {
  safety: 0.6,
  accuracy: 0.6,
  completeness: 0.6,
  groundedness: 0.6,
};

/** 连续低分次数达到此值 → 停止自动回答（05 §5.6） */
export const LOW_SCORE_STREAK_LIMIT = 3;

/* ============================ 安全规则表 ============================ */

interface SafetyRule {
  id: string;
  pattern: RegExp;
  /** 命中后对答案做什么 */
  action: ReviewIssue['action'];
  detail: string;
  /** 替换文本；action='blocked' 时为整段替换 */
  replacement?: string;
}

/**
 * 安全硬拦截规则。**这些不是"扣分项"，是"不能出现"**。
 *
 * 踩的是 docs/08 §1 的四个绝对不做：
 *   诊断疾病 / 开药建议剂量 / 建议停药换药 / 替代医生判断
 */
const SAFETY_RULES: SafetyRule[] = [
  // ---- 诊断结论 ----
  {
    id: 'diagnosis',
    pattern: /(你(这是|得了|患了|属于)|确诊为|诊断为|可以确定(是|为)|一定是)[^。！？\n]{0,20}(病|症|炎|癌|瘤|感染|障碍|综合征|感冒|流感|胃炎|肺炎)/,
    action: 'rewritten',
    detail: '答案给出了诊断结论，已改写为"可能相关，需医生确认"',
    replacement: '这些表现可能和某些疾病相关，但需要医生面诊确认。',
  },
  // ---- 推荐处方（先匹配常见药名，再匹配"药/片"等品类词） ----
  {
    id: 'prescription',
    pattern: /(建议|可以|应该|试试|不妨)(吃|服用|用|吃点|喝|买点)[^。！？\n]{0,12}(药|片|胶囊|颗粒|口服液|布洛芬|阿司匹林|对乙酰氨基酚|头孢|阿莫西林|奥美拉唑|二甲双胍|蒙脱石|板蓝根|感冒灵|连花清瘟)/,
    action: 'rewritten',
    detail: '答案建议了具体用药，已删除（开药不在本项目范围内）',
    replacement: '具体用什么药需要医生根据你的情况开处方。',
  },
  // ---- 药名 + 用法（不带剂量也算处方建议） ----
  {
    id: 'drug_advice',
    pattern: /(吃点|服用|口服|涂抹)[^。！？\n]{0,6}(布洛芬|阿司匹林|对乙酰氨基酚|头孢|阿莫西林|奥美拉唑|二甲双胍|感冒药|消炎药|抗生素)/,
    action: 'rewritten',
    detail: '答案推荐了具体药物，已删除',
    replacement: '具体用药请由医生决定。',
  },
  {
    id: 'dosage',
    pattern: /\d+\s*(mg|毫克|g|克|ml|毫升|片|粒)[^。！？\n]{0,6}(每次|每日|一天|一日|口服)/,
    action: 'blocked',
    detail: '答案给出了具体剂量，属于高风险内容，整段已拦截',
  },
  // ---- 停药换药 ----
  {
    id: 'stop_medication',
    pattern: /(停药|停掉|停用|不用吃了|别再吃|换(成|用)别的?药|改用)/,
    action: 'rewritten',
    detail: '答案涉及停药或换药建议，已改写为"请咨询原开方医生"',
    replacement: '是否调整用药必须由原开方医生判断，请不要自行停药或换药。',
  },
  // ---- 替代医生判断 ----
  {
    id: 'replace_doctor',
    pattern: /(不用(去看|找)医生|不需要(去)?医院|没必要(去)?检查|可以不去)/,
    action: 'rewritten',
    detail: '答案弱化了就医必要性，已改写',
    replacement: '是否需要就医建议还是让医生判断。',
  },
];

/** 通用免责声明：Judge 失败或低分时强制追加 */
export const GENERIC_CAVEAT =
  '本回答仅用于信息整理与就诊准备参考，不构成诊断或用药建议。具体诊疗请遵医嘱。';

/**
 * 执行安全规则。返回改写后的文本 + 问题清单。
 * 纯函数，可单测。
 */
export function applySafetyRules(answer: string): {
  answer: string;
  issues: ReviewIssue[];
  blocked: boolean;
} {
  let text = answer;
  const issues: ReviewIssue[] = [];
  let blocked = false;

  for (const rule of SAFETY_RULES) {
    if (!rule.pattern.test(text)) continue;

    const matched = text.match(rule.pattern)?.[0] ?? '';
    issues.push({
      type: 'unsafe',
      detail: `${rule.detail}（命中片段：${matched.slice(0, 30)}）`,
      action: rule.action,
    });

    if (rule.action === 'blocked') {
      blocked = true;
    } else if (rule.action === 'rewritten' && rule.replacement) {
      text = text.replace(rule.pattern, rule.replacement);
    } else if (rule.action === 'removed') {
      text = text.replace(rule.pattern, '');
    }
  }

  return { answer: text, issues, blocked };
}

/* ============================ 交叉检查 ============================ */

/**
 * 剥掉"带紧急处置指引"的句子，只留下纯描述。
 *
 * <p>判据不是"含不含急症词"，而是**这句话是否同时给出了行动指引**：
 * <pre>
 *   应该在复检中被拦下的（描述病人在出事）：
 *     「患者一侧肢体无力，言语不清」        ← 描述
 *     「你这是卒中，需要马上手术」          ← 结论
 *
 *   不该被拦下的（在教用户何时就医）：
 *     「若出现一侧肢体无力、言语不清，应立即拨打 120」   ← 有指引
 *     「出现胸痛请立即就医，不要自行开车」              ← 有指引
 * </pre>
 *
 * <p>判据取"条件词 + 指引词"：条件词说明这是假设情形（若/如果/一旦），
 * 指引词说明作者在教用户怎么做（拨打 120 / 立即就医 / 急诊）。
 * 两者同时出现，就认为是安全提示而不是病情描述。
 *
 * <p><b>宁可少剥，不可多剥</b>：剥多了会让真正的漏报溜过去。
 * 所以要求条件词与指引词**都在同一句内**，不做跨句判断。
 */
export function stripEmergencyGuidance(answer: string): string {
  /*
   * 判据必须**严格**：只要放进来一个宽松的词，就会漏报真正的急症描述。
   *
   * 第一版把「出现」「需要」「立刻」都算进去了，结果
   * 「你这是急性心梗，需要立刻手术」被判成"就医指引"直接放过 ——
   * 这是漏报，比误报危险得多。测试当场抓到了。
   *
   * 现在只认真正的假设连词。注意「如果/若」这类词在病情描述里几乎不出现，
   * 而「出现」会 ——「出现剧烈头痛」是描述，不是假设。
   */
  const CONDITION = /(若|如果|一旦|假如|要是|如有|若有|倘若|万一)/;
  const ACTION = /(拨打\s*120|叫救护车|立即(就)?(医|就诊|到急诊)|尽快(就)?医|马上就医|急诊|不要自行开车)/;

  /*
   * 否定句：「不等于心梗」「不一定是心梗」「排除心梗」——
   * 这是在**排除**急症，不是描述急症。
   *
   * 这一条是被组合测试逼出来的：给 red-flag 补上「心梗」之后，
   * 「血压偏高本身不等于心梗」这类科普句会被误判成急诊。
   * 注意要求否定词与急症词**紧邻**（间隔 0-6 字），
   * 避免把「不是小事，可能是心梗」这种真描述错当否定。
   */
  const NEGATED = /(不等于|不一定是|未必是|不是|排除|并非|不像是)[^，。；]{0,6}(心梗|心肌梗死|卒中|中风|大出血)/;

  return answer
    .split(/(?<=[。！？；\n])/)
    .filter((sentence) => {
      // 剥掉"带假设 + 带行动指引"的句子（
      // 这是安全提示，不是病情描述
      if (CONDITION.test(sentence) && ACTION.test(sentence)) return false;
      // 剥掉"明确否定急症"的句子
      if (NEGATED.test(sentence)) return false;
      return true;
    })
    .join('');
}

export interface CrossCheckInput {
  answer: string;
  facts: SessionFacts;
}

export interface CrossCheckResult {
  issues: ReviewIssue[];
  /** 需要追加到答案前的警示条 */
  warnings: string[];
}

/**
 * 过敏交叉检查：答案里提到了用户过敏物 → 警示。
 *
 * 为什么只提示不判断：我们不知道患者对什么过敏到什么程度
 * （是皮疹还是过敏性休克），也不知道剂量与给药途径。
 * 提示"你记录里对青霉素过敏，这个药名相关"是安全的；
 * 说"你不能用这个药"就越界了。
 */
export function allergyCrosscheck({ answer, facts }: CrossCheckInput): CrossCheckResult {
  const issues: ReviewIssue[] = [];
  const warnings: string[] = [];

  for (const allergen of facts.allergies) {
    if (!allergen) continue;
    if (!answer.includes(allergen)) continue;

    issues.push({
      type: 'unsafe',
      detail: `答案提及了你的过敏记录：${allergen}`,
      action: 'flagged',
    });
    warnings.push(
      `⚠️ 你的记录里对「${allergen}」过敏，本次回答提到了它。请务必主动告知医生你的过敏史。`,
    );
  }

  return { issues, warnings };
}

/**
 * 用药冲突提示：多院处方含相同成分。
 * 输入为药物名列表（来自 facts.currentMedications），
 * 本项目只做「同一成分出现多次」的提示，不做相互作用判断。
 */
export function drugConflictCheck({ answer, facts }: CrossCheckInput): CrossCheckResult {
  const issues: ReviewIssue[] = [];
  const warnings: string[] = [];

  const meds = facts.currentMedications.filter(Boolean);
  if (meds.length < 2) return { issues, warnings };

  // 只看答案里同时提到的药，避免对无关内容提示
  const mentioned = meds.filter((m) => answer.includes(m));
  if (mentioned.length >= 2) {
    issues.push({
      type: 'unsafe',
      detail: `答案同时提到了多种在用药物：${mentioned.join('、')}`,
      action: 'flagged',
    });
    warnings.push(
      `⚠️ 你在不同医院开过「${mentioned.join('、')}」，请在就诊时把完整用药清单给医生看，确认能否同服。`,
    );
  }

  return { issues, warnings };
}

/* ============================ 四维打分 ============================ */

export interface JudgeDeps {
  /**
   * LLM-as-judge。返回四维分数。返回 null 或抛错 → 走"跳过自评但加免责"。
   */
  judge?: (input: {
    answer: string;
    evidenceCount: number;
  }) => Promise<ReviewScores | null>;
}

/**
 * 规则先算一遍基础分，再由 judge 调整。
 * 这样即使 judge 挂了，分数也不是空的 —— 失败保守，不等于失败放弃。
 */
export function ruleBasedScores(
  answer: string,
  evidenceCount: number,
  safetyIssues: number,
): ReviewScores {
  // safety：有安全问题时直接归零，无问题给满分（规则说没事就是没事）
  const safety = safetyIssues > 0 ? 0 : 1;

  // groundedness：有证据加分；无证据且答案较长 → 低分
  const groundedness =
    evidenceCount >= 2 ? 0.85 : evidenceCount === 1 ? 0.65 : answer.length > 120 ? 0.4 : 0.6;

  // completeness：粗略用是否含"建议/需要/可以"这类收束句判断
  const hasClosure = /(建议|需要|可以|请|考虑)/.test(answer);
  const completeness = hasClosure ? 0.75 : 0.55;

  // accuracy：无证据时保守给中位
  const accuracy = evidenceCount > 0 ? 0.75 : 0.6;

  return { safety, accuracy, completeness, groundedness };
}

export function overallScore(s: ReviewScores): number {
  // safety 权重最高：它不合格，整体就不合格
  const w = { safety: 0.4, accuracy: 0.25, groundedness: 0.2, completeness: 0.15 };
  const sum =
    s.safety * w.safety +
    s.accuracy * w.accuracy +
    s.groundedness * w.groundedness +
    s.completeness * w.completeness;
  return Number(sum.toFixed(2));
}

export function belowThreshold(s: ReviewScores, t: ReviewScores): boolean {
  return (
    s.safety < t.safety ||
    s.accuracy < t.accuracy ||
    s.completeness < t.completeness ||
    s.groundedness < t.groundedness
  );
}

/* ============================ 主处理 ============================ */

export interface ReviewInputPayload {
  candidateAnswer: string;
  evidenceCount?: number;
  thresholds?: Partial<ReviewScores>;
  /** 同类问题连续低分次数，由会话状态带入 */
  lowScoreStreak?: number;
}

export function makeReviewer(deps: JudgeDeps = {}) {
  async function handle(
    input: AgentInput<ReviewInputPayload>,
  ): Promise<AgentOutput<ReviewerPayload>> {
    const {
      candidateAnswer,
      evidenceCount = 0,
      thresholds: th,
      lowScoreStreak = 0,
    } = input.payload;

    const thresholds: ReviewScores = { ...DEFAULT_THRESHOLDS, ...th };
    const facts = input.facts;
    const events: AgentEvent[] = [];
    const issues: ReviewIssue[] = [];
    let degraded: AgentOutput<ReviewerPayload>['degraded'];

    /* ---- 第 1 步：红线复检（纯规则，最先做） ---- */
    /*
     * 只检查"答案是否在描述某个病人的急症"，**不检查"答案是否在给急症指引"**。
     *
     * 这一条是实测出来的：用户问「同时吃阿司匹林和氨氯地平要注意什么」，
     * 模型回答里有一句「若头晕伴有一侧肢体无力、言语不清、口角歪斜，
     * 应按卒中处理，立即拨打 120」—— 这是**正确且有价值的安全提示**，
     * 但旧逻辑按急症词匹配，把它判成了"答案在描述急症"，
     * 直接中断整轮并弹出红色急诊卡。
     *
     * 后果比误报更严重：用户只是问用药，却被告知"可能中风"。
     * 所以先剥离掉带紧急指引的句子，再对剩下的内容做复检。
     */
    const red = recheckAnswer(stripEmergencyGuidance(candidateAnswer));
    if (red) {
      events.push({ type: 'emergency', redFlag: red });
      issues.push({
        type: 'unsafe',
        detail: '答案涉及急症表现，已强制转为急诊指引',
        action: 'blocked',
      });
      const payload: ReviewerPayload = {
        scores: { safety: 0, accuracy: 0, completeness: 0, groundedness: 0 },
        overall: 0,
        issues,
        caveat: red.guidance,
      };
      events.push({ type: 'review_trace', scores: payload.scores, action: 'pass' });
      return { status: 'blocked', payload, confidence: 1, evidence: [], events };
    }

    /* ---- 第 2 步：安全规则硬拦截（规则优先于分数） ---- */
    const safety = applySafetyRules(candidateAnswer);
    let answer = safety.answer;
    issues.push(...safety.issues);

    if (safety.blocked) {
      const blockCaveat =
        '这段内容涉及具体用药剂量，超出本系统能力范围。请直接咨询医生或药师。' + GENERIC_CAVEAT;
      const payload: ReviewerPayload = {
        scores: { safety: 0, accuracy: 0, completeness: 0, groundedness: 0 },
        overall: 0,
        issues,
        caveat: blockCaveat,
      };
      events.push({ type: 'review_trace', scores: payload.scores, action: 'pass' });
      events.push({ type: 'caveat', text: blockCaveat });
      return { status: 'blocked', payload, confidence: 1, evidence: [], events };
    }

    /* ---- 第 3 步：交叉检查（过敏 / 用药） ---- */
    const allergy = allergyCrosscheck({ answer, facts });
    issues.push(...allergy.issues);
    const drug = drugConflictCheck({ answer, facts });
    issues.push(...drug.issues);

    const warnings = [...allergy.warnings, ...drug.warnings];
    for (const w of warnings) {
      events.push({ type: 'caveat', text: w });
    }

    /* ---- 第 4 步：四维打分 ---- */
    const baseScores = ruleBasedScores(answer, evidenceCount, issues.filter((i) => i.type === 'unsafe').length);
    let scores = baseScores;

    if (deps.judge) {
      try {
        const judged = await withGuard(deps.judge({ answer, evidenceCount }));
        if (judged) {
          // 规则与 judge 冲突时规则优先：safety 取两者更低值
          scores = {
            ...judged,
            safety: Math.min(judged.safety, baseScores.safety),
          };
        } else {
          degraded = { stage: 'reviewer', reason: 'judge returned null', fallback: 'rule-scores' };
        }
      } catch {
        degraded = { stage: 'reviewer', reason: 'judge failed', fallback: 'rule-scores' };
      }
    }

    const overall = overallScore(scores);
    const low = belowThreshold(scores, thresholds);

    /* ---- 第 5 步：连续低分熔断 ---- */
    if (low && lowScoreStreak + 1 >= LOW_SCORE_STREAK_LIMIT) {
      const circuitCaveat =
        '这个问题的回答质量我们送不出手，已连续多次未能给出可靠答案。建议直接咨询医生，或拨打医院咨询电话。';
      const payload: ReviewerPayload = {
        scores,
        overall,
        issues,
        caveat: circuitCaveat,
      };
      events.push({ type: 'review_trace', scores, action: 'pass' });
      events.push({ type: 'caveat', text: circuitCaveat });
      return { status: 'blocked', payload, confidence: 1, evidence: [], events };
    }

    /* ---- 第 6 步：低分回退（发 retry，让前端看到"重来一次"） ---- */
    const action: 'pass' | 'retry' = low ? 'retry' : 'pass';
    events.push({ type: 'review_trace', scores, action });

    if (low) {
      events.push({
        type: 'retry',
        reason: `四维评分未达阈值（综合 ${overall}）`,
        from: 'reviewer',
        to: 'supervisor',
        round: lowScoreStreak + 1,
      });
    }

    /* ---- 第 7 步：必定追加免责声明 ---- */
    // 三种情况都加：低分 / judge 失败 / 无证据。其余情况也加 —— 医疗场景一律加。
    const caveatParts: string[] = [];
    /*
     * degraded 的确切含义：**模型 judge 调用失败，已降级为规则评分**。
     *
     * 文案要区分这一点。原来写的是「本轮质量评估未能完成，已按最保守标准处理」，
     * 实测与界面矛盾：自检结果标签显示绿色的「通过」，四项分数也都有值
     * （因为规则评分确实算出来了），紧接着一句话说"评估未能完成"，
     * 用户不知道到底评没评。
     *
     * 现在的说法把事实讲全：评估做了（规则做的），只是没走模型那一层。
     */
    if (degraded) {
      caveatParts.push('本轮由规则完成质量检查（模型评分暂不可用），结论已按较保守的方式给出。');
    }
    if (evidenceCount === 0) caveatParts.push('本回答没有引用具体资料，仅作一般性说明。');
    caveatParts.push(GENERIC_CAVEAT);

    const caveat = caveatParts.join('');
    events.push({ type: 'caveat', text: caveat });

    const payload: ReviewerPayload = { scores, overall, issues, caveat };

    return {
      status: low ? 'failed' : 'ok',
      payload,
      confidence: 1,
      evidence: [],
      events,
      ...(degraded ? { degraded } : {}),
    };
  }

  return (input: AgentInput<ReviewInputPayload>) =>
    safeRun(handle, input, {
      agent: 'reviewer',
      timeoutMs: REVIEW_TIMEOUT_MS,
      fallback: {
        ...emptyOutput<ReviewerPayload>({
          scores: { safety: 1, accuracy: 0, completeness: 0, groundedness: 0 },
          overall: 0,
          issues: [{ type: 'inaccurate', detail: '审查服务不可用', action: 'flagged' }],
          caveat: GENERIC_CAVEAT,
        }),
        // 失败保守：即使审查挂了，免责声明也必须出现
        events: [{ type: 'caveat', text: GENERIC_CAVEAT }],
      },
    });
}

function withGuard<T>(p: Promise<T>, ms = 5000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('judge timeout')), ms)),
  ]);
}

/** 导出的改写结果，供 chat 路由把安全改写后的文本下发 */
export function sanitizeAnswer(answer: string): { answer: string; blocked: boolean } {
  const r = applySafetyRules(answer);
  return { answer: r.answer, blocked: r.blocked };
}
