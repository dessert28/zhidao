/* ------------------------------------------------------------------
 * 检查顺序规划 —— 「先抽血还是先拍片」
 *
 * ============ 它解决什么 ============
 *
 * 检查单解析（order-parse.ts）只回答了"要做哪几项"，没回答"谁先做"。
 * 而顺序错了，患者会白跑：
 *   · 先去拍 CT，排号等一小时，抽血窗口到点关了 → 当天做不完
 *   · 先吃了东西，再去做需要空腹的抽血 → 抽不了，第二天再来
 *
 * 所以这一层把 ParsedExam[] 排成一个有理由的先后次序，
 * 每一句理由都是给患者看的，不是内部编号。
 *
 * ============ 排序规则（为什么是这个顺序） ============
 *
 *   1. **需要空腹的抽血** —— 患者此刻正空着肚子。先抽完就能进食，
 *      这一条不只是"快"，而是"抽血是空腹状态唯一不可替代的窗口期"。
 *      排在后面意味着患者要饿更久，或者干脆饿过头吃了东西白跑。
 *   2. **需要预约/排号的影像（CT / MRI / 内镜 / 造影等）** ——
 *      这类检查的等待发生在"排上号之前"，把号排上之后患者可以去做别的。
 *      先排号等于把漫长的等待和别的项目并行起来。
 *   3. **也需要空腹、但不属于上面两类的项目（如腹部彩超）** ——
 *      它的约束同样是"必须在进食前完成"，所以也往前放。
 *   4. **其余已知项目（不需空腹的抽血、心电图、普通超声）** ——
 *      它们没有时间窗口约束，就近顺路做即可，保持检查单原顺序。
 *   5. **空腹状态未知（fasting === null）的项目** —— 排最后并标
 *      needsConfirmation。理由：我们既不能说它不用空腹（万一要空腹，
 *      患者提前吃了就白跑），也不能把它当空腹项目往前排（万一是
 *      有创/特殊准备，顺序要听医生的）。正确做法是让患者先问分诊台。
 *
 *   一处刻意的例外：**需要预约的影像即使空腹状态未知，仍排在第 2 类**。
 *   因为它的优先级来自"要排号等很久"这个流程事实，与空腹无关；
 *   CT 的检查单上几乎不会写"无需空腹"，若因此把它压到最后，
 *   恰恰破坏了本模块最主要的使用场景。这类项目仍会带
 *   needsConfirmation 提示，患者照样会被提醒去确认。
 *
 * ============ 诚实边界 ============
 *
 * **这是流程规则，不是医学判断。** 它不知道患者的病情、不知道哪项检查
 * 更急、不知道院内实际排队长度和楼层距离，也不判断某项检查能不能合并做。
 *
 * 所有有创检查（内镜、活检、增强造影）、需要特殊准备的项目（憋尿、
 * 停用某些药物、家属陪同），顺序一律**以医生和分诊台的安排为准**。
 * 本模块给出的只是"一般情况下更省时间"的先后建议，界面上必须把它
 * 表述成建议，而不是指令。
 * ------------------------------------------------------------------ */

import type { ParsedExam } from './order-parse';

/** 规划后的一步 —— 给界面直接渲染 */
export interface PlannedStep {
  /** 原检查项目，不做任何改写 */
  exam: ParsedExam;
  /** 第几步，从 1 开始 */
  order: number;
  /** 给患者看的一句话理由 */
  reason: string;
  /** 空腹状态未知，需要患者先去问分诊台 */
  needsConfirmation: boolean;
}

/**
 * 需要预约/排号的影像关键词。
 *
 * <p>为什么不用 placeType 判断：EXAM 里混着心电图、普通超声这类
 * "到了就能做、几分钟出结果"的项目，把它们排到前面反而让患者多跑一趟。
 * 只有这几类是真的要先排号、等待时间不可控的。
 */
const APPOINTMENT_IMAGING = /(CT|核磁|磁共振|MRI|内镜|胃镜|肠镜|造影|增强|PET|DSA)/i;

/**
 * 排序档位。数值即先后，越小越先做。
 *
 * <p>用显式常量而不是裸数字，是为了让"调整顺序"这件事只改一处，
 * 也让每档的取舍理由能写在名字上。
 */
const TIER = {
  /** 需要空腹的抽血：趁患者还空着肚子，先抽 */
  FASTING_LAB: 0,
  /** 需要预约/排号的影像：先排上号，把等待和别的项目并行 */
  APPOINTMENT_IMAGING: 1,
  /** 其它需要空腹的项目（腹部彩超等）：同样赶在进食前 */
  FASTING_OTHER: 2,
  /** 已知不需要空腹的常规项目：就近顺路做 */
  ROUTINE: 3,
  /** 空腹状态未知：排最后，先让患者问清楚 */
  UNKNOWN_FASTING: 4,
} as const;

type Tier = (typeof TIER)[keyof typeof TIER];

/** 这项是不是需要先排号的影像 */
function isAppointmentImaging(exam: ParsedExam): boolean {
  return exam.placeType === 'EXAM' && APPOINTMENT_IMAGING.test(exam.name);
}

/** 归到哪一档。判断顺序即优先级，见文件头注释 */
function tierOf(exam: ParsedExam): Tier {
  if (exam.fasting === true && exam.placeType === 'LAB') return TIER.FASTING_LAB;

  // 预约类影像优先于"空腹未知"：优先级来自排号，不来自空腹（见文件头）
  if (isAppointmentImaging(exam)) return TIER.APPOINTMENT_IMAGING;

  if (exam.fasting === true) return TIER.FASTING_OTHER;

  // 走到这里 fasting 只剩 false / null。null 单独一档，理由见文件头第 5 条
  if (exam.fasting === null) return TIER.UNKNOWN_FASTING;

  return TIER.ROUTINE;
}

/** 每一档给患者的一句话理由 */
function reasonOf(exam: ParsedExam, tier: Tier): string {
  switch (tier) {
    case TIER.FASTING_LAB:
      return '先抽血：这项需要空腹，抽完就能吃东西，不用一直空着肚子等。';
    case TIER.APPOINTMENT_IMAGING:
      return exam.fasting === true
        ? `先排号：${exam.name}要预约或排队，等的时间长，而且这项也得空腹，先把号排上。`
        : `先排号：${exam.name}通常要预约或排队，可能等很久，先把号排上再去做别的。`;
    case TIER.FASTING_OTHER:
      return '趁还空着肚子做：这项也要空腹，抽完血、排上号之后接着做，做完再吃东西。';
    case TIER.ROUTINE:
      return '顺路做：这项不用空腹，等抽血和需要排号的项目做完，就近安排就行。';
    case TIER.UNKNOWN_FASTING:
      return '先问分诊台：这项检查单上没写要不要空腹，问清楚再决定先做还是后做。';
  }
}

/**
 * 把检查项目排成先后顺序。
 *
 * <p>同一档内保持检查单原顺序 —— 患者手里拿着单子对照时，
 * 顺序和单子一致最容易核对；同档内的先后本来也没有依据，
 * 强行按名字或耗时再排一次，只会让界面看起来"很有道理"却毫无依据。
 *
 * @param exams 检查单解析结果，顺序即检查单上的原始顺序
 * @returns 带编号与理由的步骤；空输入返回空数组（不编步骤）
 */
export function planExamSequence(exams: readonly ParsedExam[]): PlannedStep[] {
  // 带上原始下标作为同档内的次序依据，避免依赖 sort 的稳定性
  const decorated = exams.map((exam, index) => ({ exam, index, tier: tierOf(exam) }));

  decorated.sort((a, b) => a.tier - b.tier || a.index - b.index);

  return decorated.map((d, i) => ({
    exam: d.exam,
    order: i + 1,
    reason: reasonOf(d.exam, d.tier),
    needsConfirmation: d.exam.fasting === null,
  }));
}
