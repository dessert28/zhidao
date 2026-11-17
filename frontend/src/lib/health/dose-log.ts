/* ------------------------------------------------------------------
 * 服药记录 —— 「这一档我吃了」
 *
 * ============ 为什么必须存在 ============
 *
 * 原来这里只有一句「时间已过」。患者想知道的是「我吃过没有」，
 * 而界面只告诉他"时间过了"—— 于是老人只能凭记忆，或者干脆重吃一次。
 * 一个只管提醒、不管确认的用药清单，是半成品。
 *
 * ============ 三条边界，按优先级 ============
 *
 * 1. **只有三种状态，没有第四种「没吃」。**
 *    待服 / 已服用 / 已跳过。"没有操作"不等于"漏服"——
 *    替他下这个结论，是把提醒变成指责。这也是 docs/08 的态度。
 *
 * 2. **记录只是记录。**
 *    它不会变成医嘱、不进摘要给医生看、不参与任何用药推理。
 *    医生不关心"患者点了几个勾"，关心的是"到底吃了没有"——而后者
 *    这张表证明不了，只能说明患者自述点过。
 *
 * 3. **数据留在本机。**
 *    服药史是最敏感的推断材料（病种、依从性、作息）。
 *    与病历一致，存在 localStorage，不上传。
 * ------------------------------------------------------------------ */

export type DoseStatus = 'taken' | 'skipped';

/** 日期(YYYY-MM-DD) → 服药档位的 id → 状态 */
export type DoseLog = Record<string, Record<string, DoseStatus>>;

const STORAGE_KEY = 'zhidao.dose-log.v1';

/**
 * 只保留最近多少天。
 *
 * <p>不是存储空间问题（一天最多 10 档、一年也就几千条），
 * 是**隐私与心智负担**：一份两年的服药打卡表，没人会去看，
 * 却会在手机上一直躺着。30 天足够回答"我最近按时吃了吗"。
 */
export const KEEP_DAYS = 30;

/** 读全量记录。数据坏了就当空 —— 一份读不出来的记录不该让整页崩 */
export function readDoseLog(): DoseLog {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as DoseLog;
  } catch {
    return {};
  }
}

/** 写全量记录，并顺手清掉过期的日子 */
export function writeDoseLog(log: DoseLog, today = todayStr()): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pruneLog(log, today)));
  } catch {
    /*
     * 隐私模式下 localStorage 会直接抛异常。
     * 这里**不能抛给上层**：写失败只意味着"这次没记住"，
     * 页面本身照常可用，吞掉比让整个今日清单白屏强。
     */
  }
}

/** 取某一天的状态表 */
export function getDayStatus(log: DoseLog, date: string): Record<string, DoseStatus> {
  return log[date] ?? {};
}

/**
 * 记下某一档的状态。
 *
 * <p>`status` 传同一个值表示**取消**（再点一次「已服用」就不吃了）——
 * 用手势而不是再加一个"撤销"按钮：药盒上只有一颗药的格子，
 * 点一下是吃，再点一下是记错了。
 */
export function setDoseStatus(
  log: DoseLog,
  date: string,
  slotId: string,
  status: DoseStatus | null,
): DoseLog {
  const day = { ...(log[date] ?? {}) };
  if (status === null) delete day[slotId];
  else day[slotId] = status;
  return { ...log, [date]: day };
}

/** 清掉 KEEP_DAYS 之前的记录 */
export function pruneLog(log: DoseLog, today = todayStr()): DoseLog {
  const cutoff = new Date(`${today}T00:00:00`);
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS + 1);
  const from = toDateStr(cutoff);

  const out: DoseLog = {};
  for (const [date, day] of Object.entries(log)) {
    // 日期是 YYYY-MM-DD，字典序即时间序
    if (date >= from && date <= today) out[date] = day;
  }
  return out;
}

/** 本地日期（不用 toISOString：那是 UTC，晚上 8 点后会算成明天） */
export function todayStr(now = new Date()): string {
  return toDateStr(now);
}

function toDateStr(d: Date): string {
  return d.toLocaleDateString('sv-SE');
}

/**
 * 一天的完成情况，给界面一句话。
 *
 * <p>措辞刻意避开"依从性""漏服"：那是医生评估用的词，
 * 患者看到只会觉得自己被考核了。
 */
export function summarizeProgress(
  slotIds: string[],
  status: Record<string, DoseStatus>,
): { taken: number; skipped: number; total: number; text: string } {
  const total = slotIds.length;
  let taken = 0;
  let skipped = 0;
  for (const id of slotIds) {
    if (status[id] === 'taken') taken += 1;
    else if (status[id] === 'skipped') skipped += 1;
  }

  if (total === 0) return { taken, skipped, total, text: '' };
  if (taken === 0 && skipped === 0) {
    return { taken, skipped, total, text: `今天 ${total} 档，都还没到记录的时候。` };
  }
  const rest = total - taken - skipped;
  const bits = [`已记录 ${taken} 档`];
  if (skipped > 0) bits.push(`跳过 ${skipped} 档`);
  if (rest > 0) bits.push(`还有 ${rest} 档没记录`);
  return { taken, skipped, total, text: bits.join(' · ') };
}
