/* ------------------------------------------------------------------
 * 按病种的定期检查 —— 「健康管家」主动关心的部分
 *
 * ============ 它解决什么 ============
 *
 * 慢病患者最常漏的不是吃药，是**该做的检查**：
 * 糖尿病要每年查眼底、查尿微量白蛋白；高血压要定期查心电图。
 * 这些间隔在指南里写得很清楚，但没人会在患者耳边提醒。
 *
 * 这个模块根据患者档案里的慢病，算出"该做什么检查、上次什么时候做的、
 * 现在到期了吗"。
 *
 * ============ 三条设计原则 ============
 *
 * 1. **只依据明确的指南共识**。每条规则的间隔都注明出处来源
 *    （《中国2型糖尿病防治指南》等），不凭印象写。
 *
 * 2. **不知道就说不知道**。病历里查不到"上次做眼底"的记录时，
 *    状态是 UNKNOWN 而不是 DUE —— 我们不知道，不能催。
 *
 * 3. **说清为什么**。每条提醒都带 reason：「糖尿病建议每年查一次眼底，
 *    因为早期视网膜病变没有症状，发现时往往已经影响视力」。
 * ------------------------------------------------------------------ */

import type { MedicalRecord } from '../api';

/** 检查项目的到期状态 */
export type DueStatus =
  /** 已到期或超期，该做了 */
  | 'DUE'
  /** 还不到时候 */
  | 'NOT_YET'
  /** 病历里找不到做过这项的记录 —— 我们不知道，不催 */
  | 'UNKNOWN';

/** 一条定期检查建议 */
export interface CheckupSuggestion {
  /** 检查项，如「眼底检查」 */
  name: string;
  /** 适用病种 */
  condition: string;
  /** 建议间隔（月） */
  intervalMonths: number;
  /** 上次做的时间（YYYY-MM-DD）；null 表示病历里没有记录 */
  lastDone: string | null;
  /** 距上次多少个月；null 表示无记录 */
  monthsSince: number | null;
  status: DueStatus;
  /** 为什么要做 */
  reason: string;
  /** 去哪里做 / 挂什么科 */
  where: string;
  /** 依据来源（指南名），答辩时能被追问 */
  basis: string;
}

/** 规则定义 */
interface CheckupRule {
  name: string;
  /** 触发条件：档案里含有这些慢病之一 */
  conditions: string[];
  intervalMonths: number;
  /** 病历文本里出现这些词，认为做过这项检查 */
  detectPatterns: RegExp[];
  reason: string;
  where: string;
  basis: string;
}

/**
 * 规则表。
 *
 * <p>间隔取自公开的国内主流指南共识，并在 basis 里写明来源，
 * 便于被追问时回答"依据是什么"。
 *
 * <p><b>不收录"建议每年体检"这类泛化建议</b>：那不是慢病特异的，
 * 写进来只会稀释真正重要的提醒。
 */
export const CHECKUP_RULES: CheckupRule[] = [
  /* ------------------------- 糖尿病 ------------------------- */
  {
    name: '眼底检查',
    conditions: ['糖尿病', '2型糖尿病', '1型糖尿病'],
    intervalMonths: 12,
    detectPatterns: [/眼底/, /视网膜/, /眼科检查/, /散瞳/],
    reason:
      '糖尿病视网膜病变早期没有症状，等看东西模糊时往往已经影响视力。每年查一次是最有效的预防办法。',
    where: '眼科（部分医院在內分泌科复诊时可开单）',
    basis: '《中国2型糖尿病防治指南》建议确诊后每年检查眼底',
  },
  {
    name: '尿微量白蛋白 / 肾功能',
    conditions: ['糖尿病', '2型糖尿病', '1型糖尿病'],
    intervalMonths: 12,
    detectPatterns: [/尿微量白蛋白/, /尿蛋白/, /微量白蛋白/, /肌酐/, /肾功能/, /eGFR/i],
    reason:
      '糖尿病肾病是最常见的并发症之一，早期只有通过尿微量白蛋白才能发现，普通尿常规查不出来。',
    where: '内分泌科 / 肾内科（抽血+留尿，不用空腹）',
    basis: '《中国2型糖尿病防治指南》建议每年检测尿白蛋白/肌酐比值',
  },
  {
    name: '糖化血红蛋白',
    conditions: ['糖尿病', '2型糖尿病', '1型糖尿病'],
    intervalMonths: 3,
    detectPatterns: [/糖化血红蛋白/, /HbA1c/i],
    reason:
      '它反映近 2-3 个月的平均血糖，比单次血糖更能说明控制得好不好。调整用药期间需要每 3 个月查一次。',
    where: '内分泌科（抽血，不需空腹）',
    basis: '《中国2型糖尿病防治指南》建议治疗达标前每3个月检测一次',
  },
  {
    name: '足部检查',
    conditions: ['糖尿病', '2型糖尿病', '1型糖尿病'],
    intervalMonths: 12,
    detectPatterns: [/足部/, /糖尿病足/, /足背动脉/, /10g尼龙/],
    reason:
      '糖尿病会降低脚部感觉，小伤口容易发展成难愈的溃疡。每年让医生检查一次足部感觉与血供。',
    where: '内分泌科',
    basis: '《中国2型糖尿病防治指南》建议每年至少一次足部检查',
  },

  /* ------------------------- 高血压 ------------------------- */
  {
    name: '心电图',
    conditions: ['高血压'],
    intervalMonths: 12,
    detectPatterns: [/心电图/, /ECG/i],
    reason:
      '长期高血压会让心肌变厚、增加房颤风险。心电图能在还没症状时发现这些变化。',
    where: '心血管内科',
    basis: '《中国高血压防治指南》建议定期评估靶器官损害',
  },
  {
    name: '血脂检查',
    conditions: ['高血压', '糖尿病', '2型糖尿病'],
    intervalMonths: 12,
    detectPatterns: [/血脂/, /胆固醇/, /甘油三酯/, /低密度脂蛋白/, /LDL/i],
    reason:
      '血压高的人如果血脂也高，心血管风险会明显叠加。查血脂能判断要不要进一步干预。',
    where: '心血管内科 / 内分泌科（需空腹 12 小时）',
    basis: '《中国成人血脂异常防治指南》建议每年至少检测一次',
  },

  /* ------------------------- 通用 ------------------------- */
  {
    name: '肝功能',
    conditions: ['高血压', '糖尿病', '2型糖尿病'],
    intervalMonths: 12,
    detectPatterns: [/肝功能/, /转氨酶/, /ALT/i, /谷丙/],
    reason:
      '长期服药（降压药、降糖药）需要定期确认肝脏代谢正常，多数药物说明书都要求定期监测。',
    where: '消化内科 / 内分泌科（需空腹）',
    basis: '药品说明书通用要求 + 慢病管理常规',
  },
];

/** 从患者档案与病历里找最后一次做某项检查的日期 */
function findLastDone(records: MedicalRecord[], rule: CheckupRule): string | null {
  const hits: string[] = [];
  for (const r of records) {
    const text = `${r.ocrText ?? ''} ${r.diagnosisBrief ?? ''} ${r.department ?? ''}`;
    if (rule.detectPatterns.some((p) => p.test(text))) {
      hits.push(r.visitDate);
    }
  }
  if (hits.length === 0) return null;
  // 日期格式是 YYYY-MM-DD，字典序即时间序
  return hits.sort().reverse()[0]!;
}

/** 两个日期相差多少个月 */
export function monthsBetween(from: string, to: string): number {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

/**
 * 根据患者慢病与病历，生成定期检查建议。
 *
 * @param conditions 患者档案里的慢病，如 ["高血压","2型糖尿病"]
 * @param records    已有病历
 * @param today      今天（YYYY-MM-DD），便于测试注入
 */
export function buildCheckupSuggestions(
  conditions: string[],
  records: MedicalRecord[],
  today = new Date().toLocaleDateString('sv-SE'),
): CheckupSuggestion[] {
  const out: CheckupSuggestion[] = [];

  // 去重：同一病种可能被多个条件触发（"糖尿病" 与 "2型糖尿病" 都在档案里）
  const seen = new Set<string>();

  for (const rule of CHECKUP_RULES) {
    const applies = rule.conditions.some((c) => conditions.some((p) => p.includes(c)));
    if (!applies) continue;
    if (seen.has(rule.name)) continue;
    seen.add(rule.name);

    const lastDone = findLastDone(records, rule);
    const monthsSince = lastDone ? monthsBetween(lastDone, today) : null;

    let status: DueStatus;
    if (lastDone === null) {
      status = 'UNKNOWN';
    } else if ((monthsSince ?? 0) >= rule.intervalMonths) {
      status = 'DUE';
    } else {
      status = 'NOT_YET';
    }

    // 触发它的是哪个病种
    const condition =
      rule.conditions.find((c) => conditions.some((p) => p.includes(c))) ?? rule.conditions[0]!;

    out.push({
      name: rule.name,
      condition,
      intervalMonths: rule.intervalMonths,
      lastDone,
      monthsSince,
      status,
      reason: rule.reason,
      where: rule.where,
      basis: rule.basis,
    });
  }

  /*
   * 排序：该做的排前面，其次未知（需要确认），最后还不到时候。
   * 同一状态内按间隔短的优先（3 个月的糖化比 12 个月的眼底更紧要）。
   */
  const order: Record<DueStatus, number> = { DUE: 0, UNKNOWN: 1, NOT_YET: 2 };
  return out.sort((a, b) => {
    const d = order[a.status] - order[b.status];
    if (d !== 0) return d;
    return a.intervalMonths - b.intervalMonths;
  });
}

/** 给界面的一句话摘要 */
export function summarizeCheckups(list: CheckupSuggestion[]): string {
  const due = list.filter((x) => x.status === 'DUE');
  const unknown = list.filter((x) => x.status === 'UNKNOWN');

  if (due.length > 0) {
    return `有 ${due.length} 项检查该做了：${due.map((x) => x.name).join('、')}`;
  }
  if (unknown.length > 0) {
    return `${unknown.length} 项检查我们不掌握记录，建议就诊时问医生是否需要安排`;
  }
  return '需要定期做的检查都在有效期内。';
}
