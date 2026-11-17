/* ------------------------------------------------------------------
 * 用药指导 —— 从病历里读出"这药怎么吃"
 *
 * ============ 为什么这个功能必须做，又必须克制 ============
 *
 * 「一天吃几次」是患者最常问、也最容易出错的问题。
 * 但它同时是最危险的一类信息：
 *   · 说错剂量可能造成实际伤害
 *   · 我们看到的只是一段病历文本，不知道医生的完整考虑
 *
 * 所以这里的边界是（对应 docs/08 §2）：
 *   只读 —— 把病历里**已经写着**的用法整理成好读的形式
 *   不推理 —— 不从药名推出"通常怎么吃"，那是新的用药建议
 *
 * 换句话说：病历里写了「每日一次，每次一片」，我们照抄并排版；
 * 病历里只写了药名没写用法，我们**说"病历里没有记录用法"**，
 * 而不是去猜一个常见用法填上。
 *
 * ============ 为什么不做药物知识库 ============
 *
 * 建立一个"药名 → 标准用法"的词典看起来很有用，但那等于
 * 用我们的知识替代医生的处方。患者照着吃，出了事是我们的责任，
 * 而那份词典维护得再好也不可能覆盖所有情况（肝肾功能、
 * 合并用药、剂型差异都会影响）。
 * 所以宁可不做，也不能做错 —— 这写在下面的注释里，避免后人"优化"掉。
 * ------------------------------------------------------------------ */

/** 从病历里读到的一条用药记录 */
export interface MedicationInstruction {
  /** 药名 */
  name: string;
  /** 单次剂量，如「1片」「500mg」。病历没写则为 null */
  dose: string | null;
  /** 频次，如「每日3次」。病历没写则为 null */
  frequency: string | null;
  /** 时间点，如「饭后」「睡前」 */
  timing: string | null;
  /**
   * 病历上写明的具体服用时刻，如「08:00」。
   *
   * <p>只有病历里真的写了钟点才有值（「每日1次 早上8点」）。
   * 为 null 表示病历只写了频次与时机 —— 时刻由 dosing.ts 按作息推出来，
   * 那是**建议**而非医嘱，界面上必须让这两者一眼可辨。
   */
  atTime: string | null;
  /** 疗程，如「7天」 */
  duration: string | null;
  /** 原始文本片段，供患者核对 */
  source: string;
  /** 该药出现在哪次就诊 */
  hospitalCode: string;
  visitDate: string;
}

/**
 * 常见给药频次的正规写法 → 患者能懂的说法。
 *
 * <p>这个映射是**术语翻译**，不是用药知识：它不新增任何信息，
 * 只是把「qd」「bid」「TID」这类医生速记翻成人话。
 * 与"药名 → 用法"的知识库有本质区别 —— 后者是我们在开药，
 * 前者只是换了个说法。
 */
const FREQUENCY_ALIASES: Array<[RegExp, string]> = [
  [/^(qd|每日1次|每日一次|1次\/日|一天一次|1日1次)$/i, '每天 1 次'],
  [/^(bid|每日2次|每日二次|2次\/日|一天两次|1日2次)$/i, '每天 2 次'],
  [/^(tid|每日3次|每日三次|3次\/日|一天三次|1日3次)$/i, '每天 3 次'],
  [/^(qid|每日4次|每日四次|4次\/日|一天四次|1日4次)$/i, '每天 4 次'],
  [/^(q8h|每8小时1次)$/i, '每 8 小时 1 次'],
  [/^(q12h|每12小时1次)$/i, '每 12 小时 1 次'],
  [/^(qn|每晚1次|每晚一次)$/i, '每晚 1 次'],
  [/^(prn|必要时)$/i, '需要时服用'],
  [/^(qw|每周1次|每周一次)$/i, '每周 1 次'],
];

/** 时机 → 通俗说法。顺序有意义：第一个命中的生效 */
const TIMING_ALIASES: Array<[RegExp, string]> = [
  /*
   * 带具体餐次的说法必须排在裸「餐前/餐后」前面。
   * 否则「早饭后」只被读成「餐后」，丢掉"哪一餐"这个信息，
   * 时间表就没法落到「早饭后」那一段，只能退回按频次的 08:30。
   */
  [/早饭前|早餐前/, '早饭前'],
  [/早饭后|早餐后/, '早饭后'],
  [/午饭前|中饭前/, '中饭前'],
  [/午饭后|中饭后/, '中饭后'],
  [/晚饭前/, '晚饭前'],
  [/晚饭后/, '晚饭后'],
  [/餐前|饭前/, '餐前'],
  [/餐后|饭后|进食后/, '餐后'],
  [/睡前|临睡/, '睡前'],
  [/晨起|清晨|早上|早晨/, '晨起'],
  [/随餐|与食物同服/, '随餐'],
  /*
   * 空腹必须排在「餐前/晨起」之后、且只匹配真正的空腹写法。
   *
   * 「空腹血糖 6.1」是检查项名，不是吃药时机 —— 把它读成「空腹服用」，
   * 患者会拿到一条凭空出现的服药提醒。宁可漏认，不能认错。
   * 前置断言排除「空腹」后面紧跟「血糖 / 抽血 / 检查」的情况。
   */
  [/(?<!空腹)(?:空腹(?!血糖|抽血|检查|化验))/, '空腹'],
];

/**
 * 看着像药、其实不是的检查项目。
 *
 * <p>病历里写「胸部正位片」「腹部彩超」「头颅 CT」时，剂型后缀同样
 * 命中「片」。抽出来就变成「在用药：胸部正位片」——
 * 而这一条会跟着患者去看医生（摘要页是打印出来递过去的），
 * 比漏抽一条药更糟：医生会以为患者真的在吃这个。
 *
 * <p>只拦明确是检查的写法。像「复方甘草片」「胃蛋白酶片」
 * 这类真药名一个都不在表里。
 */
const EXAM_ITEM =
  /(正位片|侧位片|斜位片|轴位片|摄片|拍片|造影|超声|彩超|B超|心电图|内镜|胃镜|肠镜|磁共振|断层|扫描|检查|试验|化验|培养)/;

/**
 * 从文本里抽取用药信息。
 *
 * <p>能处理的典型写法（来自真实病历）：
 * <pre>
 *   二甲双胍缓释片 0.5g 每日2次 餐后
 *   阿司匹林肠溶片  每日一次  每次一片
 *   氨氯地平 5mg po qd
 *   1. 二甲双胍 0.5g bid 饭后
 * </pre>
 *
 * <p>抽不到就留空 —— **不猜**。调用方要把"没记录"如实展示给患者。
 */
export function extractMedications(
  text: string,
  hospitalCode = '',
  visitDate = '',
): MedicationInstruction[] {
  if (!text) return [];
  const out: MedicationInstruction[] = [];

  /*
   * 逐行处理。
   *
   * 为什么按行：药名与用法的关联依赖"它们在同一行"。
   * 整段一起匹配会让上一行的用法被算到下一行的药上 ——
   * 这种错误在用药场景里后果严重（把降压药的频次安到降糖药上）。
   */
  const lines = text.split(/[\n。；;]/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // 先找药名：中文 2-12 字 + 常见剂型后缀，或英文药名
    const nameMatch = line.match(
      /([\u4e00-\u9fa5]{2,10}(?:缓释片|肠溶片|胶囊|片|丸|颗粒|口服液|注射液|软膏|喷雾剂|滴眼液|糖浆))/,
    );
    if (!nameMatch) continue;

    const name = nameMatch[1]!;
    // 检查项也带「片 / 囊 / 液」，先按词表剔掉，别让它进用药清单
    if (EXAM_ITEM.test(name)) continue;

    out.push({
      name,
      dose: findDose(line),
      frequency: findFrequency(line),
      timing: findTiming(line),
      atTime: findAtTime(line),
      duration: findDuration(line),
      source: line,
      hospitalCode,
      visitDate,
    });
  }

  return out;
}

/** 剂量：0.5g / 500mg / 1片 / 每次一片 / 5 mg */
function findDose(line: string): string | null {
  // 数值 + 单位
  const withUnit = line.match(/(\d+(?:\.\d+)?)\s*(mg|g|ml|μg|微克|毫克|克|毫升|片|粒|单位|iu)/i);
  if (withUnit) return `${withUnit[1]}${withUnit[2]}`;

  // 「每次一片/两片」—— 中文数字统一转成阿拉伯数字，界面上一眼可比
  const cn = line.match(/每次([一二两三四五六七八九十\d]+)\s*(片|粒|袋|支|喷)/);
  if (cn) return `${cnNumToDigit(cn[1]!)}${cn[2]}`;

  // 「一次一片」
  const cn2 = line.match(/[一1]次([一二两三四五六七八九十\d]+)\s*(片|粒|袋|支|喷)/);
  if (cn2) return `${cnNumToDigit(cn2[1]!)}${cn2[2]}`;

  return null;
}

/**
 * 中文数字 → 阿拉伯数字。
 *
 * <p>只处理个位数与"十"系列 —— 剂量不会出现"一百片"这种写法，
 * 超出范围就原样返回，不做复杂解析。
 */
function cnNumToDigit(s: string): string {
  const map: Record<string, string> = {
    一: '1', 二: '2', 两: '2', 三: '3', 四: '4',
    五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10',
  };
  if (/^\d+$/.test(s)) return s;
  return map[s] ?? s;
}

/** 频次：先按别名表翻译，翻了才返回 */
function findFrequency(line: string): string | null {
  /*
   * 直接从原文抓一个"次数表述"，再去别名表翻译。
   *
   * 注意不能反过来（先找别名再确认在原文里）：别名表里没有的写法
   * （如「2次/日」的变体）就抓不到了。
   * 这里先抓宽泛的模式，再尝试翻译；翻译不了就原样返回，
   * 因为原文写法本身就是医生给的，原样保留不会错。
   */
  const m =
    line.match(/(?:qd|bid|tid|qid|qn|qw|q8h|q12h|prn)/i) ||
    line.match(/每日\s*[一二三四1-4]\s*次/) ||
    line.match(/[一1]天\s*[一二三四1-4]\s*次/) ||
    line.match(/[一1]日\s*[一二三四1-4]\s*次/) ||
    line.match(/\d\s*次\s*\/\s*日/) ||
    line.match(/每\s*\d+\s*小时\s*[一1]次/) ||
    line.match(/每晚\s*[一1]\s*次/) ||
    line.match(/每周\s*[一1]\s*次/);

  if (!m) return null;
  const raw = m[0].replace(/\s+/g, '');

  for (const [re, label] of FREQUENCY_ALIASES) {
    if (re.test(raw)) return label;
  }
  // 翻译不了就原样返回 —— 原文是医生写的，保留不会错
  return m[0].trim();
}

/** 时机 */
function findTiming(line: string): string | null {
  for (const [re, label] of TIMING_ALIASES) {
    if (re.test(line)) return label;
  }
  return null;
}

/**
 * 病历上写明的具体钟点：「每日1次 早上8点」「08:00 服用」「晚 8 点半」。
 *
 * <p>只在**写成钟点**时返回，不做任何推断：
 *   · 有冒号：「8:30」「20：30」→ 直接取
 *   · 中文时间词 + 数字 + 点/时：「早上8点」「晚上八点半」「中午12时」
 *   · 「早上」「晚上」这类**时段词**不算：它不指向一个时刻，
 *     真有这个信息的是 timing，交给 dosing.ts 排进作息里
 *
 * <p>为什么这么克制：钟点一旦猜错，患者会照着错的时间吃药。
 * 「早上8点」写得很明确，「早上」则不是 —— 这两者必须区别对待。
 */
export function findAtTime(line: string): string | null {
  /*
   * 冒号写法优先。前面的前置断言排除「血糖 6.1:8」这类被拆开的数字，
   * 后面的断言排除「8:30-9:00」这类区间 —— 区间不是服药时刻，猜一个端点等于编。
   */
  const colon = line.match(/(?<!\d)([01]?\d|2[0-3])\s*[:：]\s*([0-5]\d)(?!\s*[-~～至到])/);
  if (colon) return toHhmm(colon[1]!, colon[2]!);

  // 「早上8点」「晚上八点半」「中午12时30分」
  const cn = line.match(
    /(?:早上|早晨|清晨|上午|中午|下午|傍晚|晚上|晚间|睡前|临睡|晨起)?\s*([零一二三四五六七八九十两\d]{1,3})\s*[点时]\s*(半|[零一二三四五六七八九十\d]{1,2}\s*分)?/,
  );
  if (cn) {
    let h = cnNumToNum(cn[1]!);
    if (h === null || h < 0 || h > 23) return null;
    const mm = cn[2] ? (cn[2].trim() === '半' ? 30 : cnNumToNum(cn[2]!)) : 0;
    if (mm === null || mm < 0 || mm > 59) return null;

    // 「晚上8点」是 20:00 —— 只有 1~11 点的晚场才需要加 12，
    // 12 点的「中午12点」本来就是 12:00
    const isPm = /下午|傍晚|晚上|晚间/.test(line);
    if (isPm && h >= 1 && h <= 11) h += 12;
    return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  return null;
}

/** 中文/阿拉伯数字 → 数字。认不出返回 null —— 认不出就不排，不猜 */
function cnNumToNum(s: string): number | null {
  const map: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1) return map[s] ?? null;
  // 「十一」「十二」这类两位数
  if (s.startsWith('十')) return 10 + (map[s[1]!] ?? 0);
  if (s[1] === '十') return (map[s[0]!] ?? 0) * 10 + (s[2] ? (map[s[2]] ?? 0) : 0);
  return null;
}

function toHhmm(h: string, m: string): string {
  return `${String(Number(h)).padStart(2, '0')}:${m}`;
}

/** 疗程：7天 / 2周 / 1个月 */
function findDuration(line: string): string | null {
  const m = line.match(/(\d+)\s*(天|日|周|个?月)\s*(?:疗程)?/);
  return m ? `${m[1]}${m[2]}` : null;
}

/* ============================ 展示 ============================ */

/**
 * 把一条用药记录变成一句话。
 *
 * <p>缺失的字段用「病历未记录」标明，而不是省略 ——
 * 省略会让患者以为"可能就是这样"，明确说出来才会去问医生。
 */
export function describeMedication(m: MedicationInstruction): string {
  const parts: string[] = [];
  if (m.dose) parts.push(m.dose);
  if (m.frequency) parts.push(m.frequency);
  if (m.timing) parts.push(m.timing);
  /*
   * 钟点排在时机后面，并带上「每日」二字：「每日 08:00」。
   * 不带「每日」的裸时刻会被读成"某一天的一次"，而这是长期医嘱。
   */
  if (m.atTime) parts.push(`每日 ${m.atTime}`);
  if (m.duration) parts.push(`共 ${m.duration}`);

  if (parts.length === 0) {
    return '病历里没有记录具体用法，请按药盒上的说明或咨询药师。';
  }
  return parts.join(' · ');
}

/**
 * 判断这条用药记录是否完整到可以指导患者。
 *
 * <p>只有药名、没有剂量与频次时返回 false。
 * 界面据此决定是"照方展示"还是"提醒去问医生"。
 */
export function isInstructionComplete(m: MedicationInstruction): boolean {
  return Boolean(m.frequency || m.dose);
}

/** 按药名去重，保留最近一次就诊的记录 */
export function dedupeByLatest(list: MedicationInstruction[]): MedicationInstruction[] {
  const best = new Map<string, MedicationInstruction>();
  for (const m of list) {
    const cur = best.get(m.name);
    // visitDate 是 YYYY-MM-DD，字典序即时间序
    if (!cur || m.visitDate > cur.visitDate) {
      best.set(m.name, m);
    }
  }
  return [...best.values()];
}
