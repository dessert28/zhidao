/* ------------------------------------------------------------------
 * 服药时间推导 —— 「今天几点吃药」
 *
 * ============ 它解决什么 ============
 *
 * 病历上写「每天 2 次」，患者看完就忘了。真正要回答的是
 * 「今天几点吃、吃哪几种」，而且要能一眼看完。
 *
 * ============ 四条必须守住的边界 ============
 *
 * 1. **这是建议时间，不是医嘱。**
 *    病历只说「每天 2 次」，没说 8 点还是 9 点。我们按常见作息给出
 *    一个默认时刻，界面上必须写明「时间可自行调整，以医嘱为准」。
 *    因此时间分两种，且**必须一眼可辨**：
 *      · 精确时间 —— 病历或患者自己定的钟点（`kind: 'exact'`）
 *      · 模糊时间 —— 只说了「早饭后」「晚饭前」，指向一段窗口
 *        （`kind: 'fuzzy'`）。窗口不是钟点，不能印成「08:30」，
 *        否则患者会以为医生说了 8 点半。
 *
 * 2. **不知道的频次不猜。**
 *    病历里只写药名没写频次时，返回 null —— 不出现在时间表里，
 *    而是单独列在「用法未记录」里提醒去问医生。
 *
 * 3. **不同的药有不同的时机要求。**
 *    餐后、睡前、晨起会显著改变时间点，这些词必须被识别并调整。
 *    一句「餐后服用」和「空腹服用」的时间差好几个小时，搞错了影响药效。
 *
 * 4. **「吃了没」必须能被记录。**
 *    只显示「时间已过」等于告诉患者"你没法确认自己吃过了" ——
 *    他要么凭记忆，要么干脆不吃了。所以要有一个「已服用」动作，
 *    把状态落到本地（见 lib/health/dose-log.ts）。
 *    状态只有三种：待服 / 已服用 / 已跳过。**没有第四种「没吃」** ——
 *    没有操作不等于漏服，界面不能替他下这个结论。
 * ------------------------------------------------------------------ */

/** 一天中的一个服药时间点 */
export interface DoseSlot {
  /** 稳定标识：`每日 08:30` 或 `每日 早饭前`。用于记住"这一档吃了没" */
  id: string;
  /**
   * 精确时间（HH:mm）。模糊时间点为 null ——
   * 窗口没有"这一刻"，硬给一个就会变成假的医嘱。
   */
  time: string | null;
  /** 文本时间：「08:30」或「早饭前」 */
  label: string;
  kind: 'exact' | 'fuzzy';
  /** 模糊时间的窗口说明，如「约 06:30–08:00」 */
  hint: string | null;
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

/* ============================ 时段 / 时段划分 ============================ */

/**
 * 一天里的「时段」—— 模糊时间的落点。
 *
 * <p>为什么时序（`order`）单独写一遍而不靠数组下标：
 * 「晨起」在「早饭前」之前，但「晨起」不是「早饭前」的别名。
 * 时刻推算时有晨起 1 次 → 07:30 的既有规则，必须保住。
 *
 * <p>`window` 顺序按一天的真实时序排列，界面靠它判断
 * 「现在落在哪一段」，`hint` 则是给患者看的作息说明。
 */
export interface SlotPeriod {
  key: string;
  /** 患者看到的名字：「早饭前」比「早餐前」更口语、更像他自己的说法 */
  label: string;
  /** 典型窗口（今天这一刻的粗略落点），仅用于提示与排序 */
  window: string;
  /** 窗口的开始/结束分钟，用于「现在还没到 / 正在这一段」 */
  from: string;
  to: string;
}

export const SLOT_PERIODS: SlotPeriod[] = [
  { key: 'wake', label: '晨起', window: '约 06:00–07:30', from: '06:00', to: '07:30' },
  { key: 'breakfast-before', label: '早饭前', window: '约 06:30–08:00', from: '06:30', to: '08:00' },
  { key: 'breakfast-after', label: '早饭后', window: '约 07:30–09:00', from: '07:30', to: '09:00' },
  { key: 'morning', label: '上午', window: '约 09:00–11:30', from: '09:00', to: '11:30' },
  { key: 'lunch-before', label: '中饭前', window: '约 11:00–12:00', from: '11:00', to: '12:00' },
  { key: 'lunch', label: '中午', window: '约 11:30–13:00', from: '11:30', to: '13:00' },
  { key: 'lunch-after', label: '中饭后', window: '约 12:00–13:30', from: '12:00', to: '13:30' },
  { key: 'afternoon', label: '下午', window: '约 14:00–17:00', from: '14:00', to: '17:00' },
  { key: 'dinner-before', label: '晚饭前', window: '约 17:00–18:30', from: '17:00', to: '18:30' },
  { key: 'dinner-after', label: '晚饭后', window: '约 18:00–19:30', from: '18:00', to: '19:30' },
  { key: 'evening', label: '睡前', window: '约 20:00–22:00', from: '20:00', to: '22:00' },
];

/**
 * 患者口气里的时段 → 时段 key。第一组匹配即返回。
 *
 * <p><b>顺序即优先级</b>：带具体餐次的写法必须排在裸的「饭前」前面，
 * 否则「晚饭前」会先被「早饭前」那一条里的 `饭前` 吃掉，
 * 落到早饭段 —— 这类错会让患者在该吃晚饭药的时候被提醒早饭。
 */
const PERIOD_PATTERNS: Array<[RegExp, string]> = [
  [/早饭前|早餐前/, 'breakfast-before'],
  [/早饭后|早餐后/, 'breakfast-after'],
  [/午饭前|中饭前/, 'lunch-before'],
  [/午饭后|中饭后/, 'lunch-after'],
  [/晚饭前/, 'dinner-before'],
  [/晚饭后/, 'dinner-after'],
  [/睡前|临睡/, 'evening'],
  [/晨起|清晨|早上|早晨/, 'wake'],
  [/中午/, 'lunch'],
  [/上午/, 'morning'],
  [/下午/, 'afternoon'],
  // 裸的「饭后/饭前」没有说是哪一餐 —— 由调用方按次数摊到三餐
  [/饭后|餐后|进食后/, 'meal-after'],
  [/饭前|餐前/, 'meal-before'],
];

/**
 * 把一段文字（时机词或患者手填的时间）解析成时段。
 *
 * <p>找不到就返回 null —— 调用方要么退化成按频次排的精确时间，
 * 要么把这条药放进「用法未记录」。不猜一个时段出来。
 *
 * <p>裸的「饭后」「饭前」（没说是哪一餐）不在这里落定：它返回的不是
 * 一个真正的时段，而是一类时机。{@link buildDosePlan} 会按次数把它
 * 摊到具体的几餐上 —— 摊几餐是排版选择，摊成哪一餐才是判断，
 * 后者不需要也不该在这里做。
 */
const MEAL_GROUPS = new Set(['meal-after', 'meal-before']);

export function parsePeriod(text: string | null | undefined): SlotPeriod | null {
  if (!text) return null;
  for (const [re, key] of PERIOD_PATTERNS) {
    if (!re.test(text)) continue;
    if (MEAL_GROUPS.has(key)) return null;
    return SLOT_PERIODS.find((p) => p.key === key) ?? null;
  }
  return null;
}

/** 这段文字说的是「饭后」还是「饭前」（不管哪一餐） */
export function parseMealGroup(text: string | null | undefined): 'after' | 'before' | null {
  if (!text) return null;
  for (const [re, key] of PERIOD_PATTERNS) {
    if (!re.test(text)) continue;
    if (key === 'meal-after') return 'after';
    if (key === 'meal-before') return 'before';
    return null; // 先说中了具体时段，就不再按裸分组处理
  }
  return null;
}

/**
 * 「三餐后」这类没有指定是哪一餐的写法，按一天的时段补齐。
 *
 * <p>「每天 1 次 + 早饭后」就是早饭这一档，不需要补；
 * 「每天 2 次 + 饭后」病历写的是"饭后"，没说哪天饭后，
 * 按次数落到最常见的几餐上 —— 这是**排版选择**，不是药理推断。
 */
function defaultPeriodsFor(count: number, group: 'after' | 'before'): string[] {
  const suffix = group === 'after' ? '-after' : '-before';
  if (count === 1) return [`breakfast${suffix}`];
  if (count === 2) return [`breakfast${suffix}`, `dinner${suffix}`];
  if (count === 3) return [`breakfast${suffix}`, `lunch${suffix}`, `dinner${suffix}`];
  return [`breakfast${suffix}`, `lunch${suffix}`, `dinner${suffix}`, 'evening'];
}

/* ============================ 频次 ============================ */

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
  // 先查中文数字表，再退回阿拉伯数字；两者都不成立时兜底为 1。
  // 这里不能用 `Number(c) ?? 1` —— Number('abc') 得到的是 NaN 而不是 null，
  // `??` 拦不住它，NaN 会一路传进剂量计算，最终显示成「NaN 片」。
  const n = Number(c);
  return map[c] ?? (Number.isFinite(n) ? n : 1);
}

function clampCount(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.round(n), 4);
}

/* ============================ 精确时间的调整 ============================ */

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
  if (/餐后|饭后/.test(timing)) {
    // 三餐后：早 8:30 / 午 13:00 / 晚 19:00
    const mealAfter =
      times.length >= 3
        ? ['08:30', '13:00', '19:00']
        : times.map((t) => addMinutes(t, 30));
    return times.length >= 4 ? times : mealAfter;
  }
  if (/餐前|饭前|空腹/.test(timing)) {
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

/** 「8:30」「8点30」「晚上8点」→ HH:mm。解析不出来返回 null */
export function normalizeClock(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();

  const colon = s.match(/^(?<!\d)([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)$/);
  if (colon) return `${String(Number(colon[1])).padStart(2, '0')}:${colon[2]}`;

  /*
   * 「晚上」「下午」这类限定词在数字**前面**，不能放进捕获组
   * （那样「晚上八点」整串都得吃进一个组）。所以先判上午/下午，再抠数字。
   */
  const isPm = /下午|傍晚|晚上|晚间/.test(s);
  const point = s.match(
    /([零一二三四五六七八九十两\d]{1,3})\s*[点时]\s*(半|[零一二三四五六七八九十]{1,2}\s*分|\d{1,2}\s*分)?/,
  );
  if (!point) return null;

  let h = cnToNumLoose(point[1]!);
  if (h === null) return null;
  const raw = point[2]?.replace(/\s*分$/, '').trim();
  const mm = raw === undefined || raw === '' ? 0 : raw === '半' ? 30 : cnToNumLoose(raw);
  if (mm === null || mm < 0 || mm > 59) return null;

  if (isPm && h >= 1 && h <= 11) h += 12;
  if (h < 0 || h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function cnToNumLoose(s: string): number | null {
  const map: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1) return map[s] ?? null;
  if (s.startsWith('十')) return 10 + (map[s[1]!] ?? 0);
  if (s[1] === '十') return (map[s[0]!] ?? 0) * 10 + (s[2] ? (map[s[2]] ?? 0) : 0);
  return null;
}

/* ============================ 时间表的构建 ============================ */

/** 一条用药信息的输入（与 medications.ts 的 MedicationInstruction 对齐） */
export interface MedInput {
  name: string;
  dose: string | null;
  frequency: string | null;
  timing: string | null;
  /** 病历上写明的钟点。有它就不按频次推 —— 医嘱优先于模板 */
  atTime?: string | null;
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
 * <p>四种输入，四种处理，顺序不能乱：
 * <pre>
 *   ① 病历写了钟点（atTime）      → 精确时间，直接用。医嘱优先，不套模板
 *   ② 频次解析不出                → unscheduled，不猜
 *   ③ 时机指向某个时段（早饭后…） → 模糊时间，落在这一段里
 *   ④ 其余                        → 按频次推精确时间
 * </pre>
 *
 * <p>同一时间点的多种药合并到一个 slot，患者看一档就知道「现在该吃哪几片」，
 * 而不是按药逐个提醒 —— 后者会让人一天被打断五六次。
 */
export function buildDosePlan(meds: MedInput[]): DosePlan {
  const byKey = new Map<string, DoseSlot>();
  const unscheduled: Array<{ name: string; frequency: string | null }> = [];

  const addMeds = (
    key: string,
    label: string,
    time: string | null,
    kind: 'exact' | 'fuzzy',
    hint: string | null,
    med: MedInput,
  ) => {
    let slot = byKey.get(key);
    if (!slot) {
      slot = { id: `每日 ${label}`, time, label, kind, hint, meds: [] };
      byKey.set(key, slot);
    }
    slot.meds.push({
      name: med.name,
      dose: med.dose,
      frequency: med.frequency ?? '',
      timing: med.timing,
    });
  };

  for (const med of meds) {
    // ① 病历写了钟点 —— 医嘱优先，不套模板
    const clock = normalizeClock(med.atTime);
    if (clock) {
      addMeds(`t:${clock}`, clock, clock, 'exact', null, med);
      continue;
    }

    const count = parseFrequencyCount(med.frequency);
    const period = parsePeriod(med.timing);

    // ② 没有频次：不猜
    if (count === null) {
      unscheduled.push({ name: med.name, frequency: med.frequency });
      continue;
    }

    /*
     * ③ 时机指向某个时段 → 模糊时间。
     *
     * 落在哪几段，按"频次有没有指定到具体哪一餐"决定：
     *   · 每天 1 次 + 早饭后 → 就是早饭后这一档
     *   · 每天 2 次 + 饭后   → 文献里没说是哪天饭后，
     *                          按次数落到早、晚两餐（排版选择，不是药理论断）
     *
     * 模糊档不落钟点 —— 患者那天早饭吃得晚，这一档就顺延，
     * 这正是它比「08:30」更贴合真实生活的地方。
     */
    /*
     * ③ 时机指向某个时段 → 模糊时间。
     *
     * 落在哪几段，按"频次有没有指定到具体哪一餐"决定：
     *   · 每天 1 次 + 早饭后 → 就是早饭后这一档
     *   · 每天 2 次 + 饭后   → 文献里没说是哪天饭后，
     *                          按次数落到早、晚两餐（排版选择，不是药理论断）
     *
     * 模糊档不落钟点 —— 患者那天早饭吃得晚，这一档就顺延，
     * 这正是它比「08:30」更贴合真实生活的地方。
     */
    if (period) {
      const keys = count === 1 ? [period.key] : defaultPeriodsFor(count, 'after');
      for (const key of keys) {
        const p = SLOT_PERIODS.find((x) => x.key === key);
        if (p) addMeds(`p:${key}`, p.label, null, 'fuzzy', p.window, med);
      }
      continue;
    }

    /*
     * 裸的「饭后」「早饭后」已经在上一步落到具体时段了；
     * 这里处理的是真正没说哪一餐的写法（如「每天 2 次 餐后」）。
     * 按次数摊到最常见的几餐 —— 摊几餐是排版选择，摊成哪一餐才叫判断，
     * 而"早饭"与"晚饭"的选择不需要额外信息就能做对。
     */
    const group = parseMealGroup(med.timing);
    if (group) {
      for (const key of defaultPeriodsFor(count, group)) {
        const p = SLOT_PERIODS.find((x) => x.key === key);
        if (p) addMeds(`p:${key}`, p.label, null, 'fuzzy', p.window, med);
      }
      continue;
    }

    // ④ 按频次推精确时间
    const base = SCHEDULE_BY_FREQUENCY[count] ?? ['08:00'];
    for (const time of applyTiming(base, med.timing)) {
      addMeds(`t:${time}`, time, time, 'exact', null, med);
    }
  }

  // 排序：模糊档按它在一天中的窗口起点排，精确档按钟点排 ——
  // 「早饭后」必须排在「10:00」前面，否则患者从下往上读会吃错顺序
  const slots = [...byKey.values()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return { slots, unscheduled };
}

function sortKey(s: DoseSlot): string {
  if (s.kind === 'exact' && s.time) return s.time;
  const p = SLOT_PERIODS.find((x) => x.label === s.label);
  return p ? p.from : '23:59';
}

/* ============================ 时间判断 ============================ */

/**
 * 判断某个时间点是否已经过去。
 *
 * <p>只用于**精确时间**。模糊时间点没有"这一刻"，问它过没过没有意义 ——
 * 那一段叫「正在这一段」还是「还没到」，由 {@link periodState} 回答。
 *
 * <p>这只是提示，不作为「你忘了吃药」的证据。
 */
export function isPast(time: string, now: Date): boolean {
  const [h, m] = time.split(':').map(Number);
  const t = new Date(now);
  t.setHours(h ?? 0, m ?? 0, 0, 0);
  return t.getTime() < now.getTime();
}

/**
 * 模糊时段相对"现在"的位置。
 *
 * <p>三态，界面上分别对应「还没到」「正在这一段」「这一段已经过了」。
 * 中间那一态是关键：模糊时间真正有用的时候，恰恰是患者**正卡在
 * 饭前饭后**的那半小时 —— 这时告诉他"现在是这一段"，比给一个钟点有用。
 */
export type PeriodState = 'upcoming' | 'now' | 'passed';

export function periodState(slot: DoseSlot, now: Date): PeriodState {
  const p = SLOT_PERIODS.find((x) => x.label === slot.label);
  if (!p) return 'upcoming';
  const cur = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (cur < p.from) return 'upcoming';
  if (cur > p.to) return 'passed';
  return 'now';
}

/**
 * 一档是"该吃了"还是"已经过了" —— 供界面排序与高亮。
 *
 * <p>精确档沿用 isPast；模糊档用 periodState。
 * 已服用/已跳过的状态不在这里判断：那是记录，不是时间。
 */
export function slotTemporal(slot: DoseSlot, now: Date): 'upcoming' | 'now' | 'passed' {
  if (slot.kind === 'exact' && slot.time) {
    return isPast(slot.time, now) ? 'passed' : 'upcoming';
  }
  return periodState(slot, now);
}

/* ============================ 摘要 ============================ */

/**
 * 今天一共几种药（按药名去重）。
 *
 * <p>不能用 `slots.reduce` 把每档的药数相加：同一盒药一天 3 次，就会
 * 在 3 个时间点里各出现一次，相加会把"2 种药"说成"6 种药"。种数是
 * 患者拿去核对药盒的数字，错一次他就不信这个界面了。
 */
export function countDistinctMeds(slots: DoseSlot[]): number {
  return new Set(slots.flatMap((s) => s.meds.map((m) => m.name))).size;
}

/** 给界面用的一句话摘要 */
export function summarizeDay(slots: DoseSlot[]): string {
  if (slots.length === 0) return '今天没有需要按时服用的药。';
  const total = countDistinctMeds(slots);
  const fuzzy = slots.filter((s) => s.kind === 'fuzzy').length;
  const tail = fuzzy > 0 ? `，其中 ${fuzzy} 档按饭后/饭前把握` : '';
  return `今天共 ${slots.length} 个服药时间点，涉及 ${total} 种药${tail}。`;
}
