/* ------------------------------------------------------------------
 * 服药时间推导 —— 「今天几点吃药」
 *
 * ============ 它解决什么 ============
 *
 * 病历上写「每天 2 次」，患者看完就忘了。真正要回答的是
 * 「今天几点吃、吃哪几种」，而且要能一眼看完。
 *
 * ============ 三条必须守住的边界 ============
 *
 * 1. **这是建议时间，不是医嘱。**
 *    病历只说「每天 2 次」，没说 8 点还是 9 点。我们按常见作息给出
 *    一个默认时刻，界面上必须写明「时间可自行调整，以医嘱为准」。
 *
 * 2. **不知道的频次不猜。**
 *    病历里只写药名没写频次时，返回 null —— 不出现在时间表里，
 *    而是单独列在「用法未记录」里提醒去问医生。
 *
 * 3. **不同的药有不同的时机要求。**
 *    餐后、睡前、晨起会显著改变时间点，这些词必须被识别并调整。
 *    一句「餐后服用」和「空腹服用」的时间差好几个小时，搞错了影响药效。
 * ------------------------------------------------------------------ */

/** 一天中的一个服药时间点 */
export interface DoseSlot {
  /** HH:mm */
  time: string;
  /** 这一档要吃的药 */
  meds: Array<{
    name: string;
    /** 剂量描述，如 "0.5g" */
    dose: string | null;
    /** 原始频次描述，如 "每天 2 次" */
    frequency: string;
    /** 时机描述，如 "餐后" */
    timing: string | null;
  }>;
}

/**
 * 按频次决定的默认时刻表。
 *
 * <p>取值依据是国人常见作息：早餐 7-8 点、午餐 12 点、晚餐 18-19 点、
 * 睡前 21-22 点。这不是药理最优，而是**最容易照做的时刻** ——
 * 一个患者真的能坚持的时间表，比理论最优但总被忘掉的有用。
 */
const SCHEDULE_BY_FREQUENCY: Record<number, string[]> = {
  1: ['08:00'],
  2: ['08:00', '20:00'],
  3: ['08:00', '12:30', '18:30'],
  4: ['08:00', '12:00', '16:00', '20:00'],
};

/** 从频次文本解析出「每天几次」。解析不出来返回 null。 */
export function parseFrequencyCount(frequency: string | null): number | null {
  if (!frequency) return null;

  const s = frequency.trim();

  // 我们自己的规范化输出：「每天 3 次」
  const m1 = s.match(/每天\s*(\d+)\s*次/);
  if (m1) return clampCount(Number(m1[1]));

  // 医生速记：「每日2次」「1日3次」「每日两次」
  // 注意中文字符集必须含「两」—— 漏掉它会让「每日两次」解析失败，
  // 而那是最常见的口语写法之一
  const m2 = s.match(/(?:每日|1日|一天)\s*([一二两三四1-9])\s*次/);
  if (m2) return clampCount(cnToNum(m2[1]!));

  // 「2次/日」
  const m3 = s.match(/(\d)\s*次\s*\/\s*日/);
  if (m3) return clampCount(Number(m3[1]));

  // 特殊频次
  if (/每晚|qn/i.test(s)) return 1;
  if (/每周/.test(s)) return null; // 每周给药不进每日清单
  const m4 = s.match(/每\s*(\d+)\s*小时/);
  if (m4) {
    const h = Number(m4[1]);
    if (h > 0) return clampCount(Math.round(24 / h));
    return null;
  }

  return null;
}

function cnToNum(c: string): number {
  const map: Record<string, number> = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  return map[c] ?? Number(c) ?? 1;
}

function clampCount(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.round(n), 4);
}

/**
 * 按时机调整时刻。
 *
 * <p>只做「明显需要挪动」的调整：
 * 餐后往后挪 30 分钟、睡前固定 21:00、晨起固定 07:30。
 * 不做精密的药代动力学计算 —— 那需要知道具体药物与患者作息，
 * 我们没有这些信息，装作有才是危险的。
 */
function applyTiming(times: string[], timing: string | null): string[] {
  if (!timing) return times;

  if (/睡前/.test(timing)) {
    // 睡前服用的药通常在晚上一次，直接把当天最后一档挪到 21:00
    if (times.length === 1) return ['21:00'];
    const next = [...times];
    next[next.length - 1] = '21:00';
    return next;
  }
  if (/晨起|清晨|早上/.test(timing)) {
    if (times.length === 1) return ['07:30'];
    const next = [...times];
    next[0] = '07:30';
    return next;
  }
  if (/餐后/.test(timing)) {
    // 三餐后：早 8:30 / 午 13:00 / 晚 19:00
    const mealAfter =
      times.length >= 3
        ? ['08:30', '13:00', '19:00']
        : times.map((t) => addMinutes(t, 30));
    return times.length >= 4 ? times : mealAfter;
  }
  if (/餐前|空腹/.test(timing)) {
    const mealBefore = times.length >= 3 ? ['07:30', '12:00', '18:00'] : times;
    return times.length >= 4 ? times : mealBefore;
  }
  return times;
}

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h ?? 0) * 60 + (m ?? 0) + minutes;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 一条用药信息的输入（与 medications.ts 的 MedicationInstruction 对齐） */
export interface MedInput {
  name: string;
  dose: string | null;
  frequency: string | null;
  timing: string | null;
}

/** 推导结果 */
export interface DosePlan {
  /** 有明确频次、可排入时间表的药 */
  slots: DoseSlot[];
  /** 频次无法解析、不进时间表的药 */
  unscheduled: Array<{ name: string; frequency: string | null }>;
}

/**
 * 把一批用药信息排成一天的服药时间表。
 *
 * <p>同一时刻的多种药合并到一个 slot，患者看一档就知道「现在该吃哪几片」，
 * 而不是按药逐个提醒 —— 后者会让人一天被打断五六次。
 */
export function buildDosePlan(meds: MedInput[]): DosePlan {
  const byTime = new Map<string, DoseSlot>();
  const unscheduled: Array<{ name: string; frequency: string | null }> = [];

  for (const med of meds) {
    const count = parseFrequencyCount(med.frequency);
    if (count === null) {
      unscheduled.push({ name: med.name, frequency: med.frequency });
      continue;
    }

    const base = SCHEDULE_BY_FREQUENCY[count] ?? ['08:00'];
    const times = applyTiming(base, med.timing);

    for (const time of times) {
      let slot = byTime.get(time);
      if (!slot) {
        slot = { time, meds: [] };
        byTime.set(time, slot);
      }
      slot.meds.push({
        name: med.name,
        dose: med.dose,
        frequency: med.frequency ?? '',
        timing: med.timing,
      });
    }
  }

  // 按时间升序
  const slots = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
  return { slots, unscheduled };
}

/**
 * 判断某个时间点是否已经过去。
 *
 * <p>用于在界面上把「今天已经该吃」的档位标灰 ——
 * 但这只是提示，不作为「你忘了吃药」的证据：
 * 我们没有打卡数据，不知道他吃没吃。
 */
export function isPast(time: string, now: Date): boolean {
  const [h, m] = time.split(':').map(Number);
  const t = new Date(now);
  t.setHours(h ?? 0, m ?? 0, 0, 0);
  return t.getTime() < now.getTime();
}

/** 给界面用的一句话摘要 */
export function summarizeDay(slots: DoseSlot[]): string {
  if (slots.length === 0) return '今天没有需要按时服用的药。';
  const total = slots.reduce((n, s) => n + s.meds.length, 0);
  return `今天共 ${slots.length} 个服药时间点，涉及 ${total} 种药。`;
}
