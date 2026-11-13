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

export const REVIEW_TIMEOUT_MS = 8000;

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
    const red = recheckAnswer(candidateAnswer);
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
    if (degraded) caveatParts.push('本轮质量评估未能完成，已按最保守标准处理。');
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
