/* ------------------------------------------------------------------
 * 化验单数值 —— 把「项目 结果 参考范围」从报告文本里读出来
 *
 * ============ 它和 markers.ts 的分工 ============
 *
 * markers.ts 只认 12 个高频指标，用的是**内置的成人参考范围**。
 * 好处是能做趋势、能给解释；代价是一张血常规 20 项里它只看得见 1 项。
 *
 * 这个模块反过来：**报告里印了什么就读什么，一项不落**，
 * 判断高低用的是**这张报告自己印出来的参考范围**（不是我们的）。
 * 所以它不做解释、不做趋势，只回答一个问题：
 * 「这份报告上哪些数字落在了它自己标的区间之外」。
 *
 * 两者不冲突：这里负责「这份报告的全部原始数值」，
 * 健康管家负责「少数指标的跨次趋势」。
 *
 * ============ 一条线 ============
 *
 * 「高于 / 低于参考范围」是**区间比较**，不是判断。
 * 所以措辞永远是「高于参考范围」，不写「偏高」「异常」「需要治疗」。
 * 参考范围因实验室而异，同一份血两家医院可能标不同区间 ——
 * 所以这里坚持用报告自带的区间，而不是我们的通用值。
 * ------------------------------------------------------------------ */

/** 与参考范围比出来的位置 */
export type LabFlag = 'high' | 'low' | 'normal' | 'unknown';

/** 报告里的一行数值 */
export interface LabValue {
  /** 项目名，如「白细胞计数」 */
  name: string;
  /** 原样的结果文本，如「6.2」「阴性」 */
  result: string;
  /** 单位，如「10^9/L」「%」。报告没印就为 null */
  unit: string | null;
  /** 参考范围原文，如「3.5-9.5」「<5.2」 */
  refText: string | null;
  refLow: number | null;
  refHigh: number | null;
  /** 与**这张报告自己印的**参考范围比出来的位置 */
  flag: LabFlag;
}

/** 汇总：给界面标题那几个数字用 */
export interface LabValueSummary {
  rows: LabValue[];
  high: number;
  low: number;
}

/**
 * 报告里的非数值行。
 *
 * <p>化验单页眉、标本信息、医师签名都会带数字（"床号 12""2026-11-18"），
 * 不排掉就会读成「床号 12 参考范围 —」这种条目。
 */
const NOISE_LINE =
  /(检查名称|检查所见|检查结论|检验项目|项目名称|姓名|性别|年龄|科室|床号|病区|住院号|门诊号|标本|样本|条码|采样|送检|报告日期|检验日期|申请日期|申请医生|检验者|审核者|审核人|医师|医生|医院|院区|地址|电话|备注|提示|意见)/;

/** 药名。门诊记录里的用药清单长得和化验单极像：「阿司匹林肠溶片 100 mg」 */
const MED_NAME = /(片|胶囊|颗粒|丸|散|注射液|注射剂|滴剂|滴眼液|软膏|乳膏|凝胶|气雾|喷雾|栓|贴|洗剂|口服液|混悬液|糖浆)$/;

/** 剂量单位。化验单几乎不用这几个（用的是 g/L、mg/dL 这种复合单位） */
const DOSE_UNIT = /^(mg|g|ug|μg|ml|mL|IU|U|片|粒|袋|支|滴|喷)$/;

/** 用药说明行，整行跳过 */
const MED_LINE = /(用法|用量|口服|外用|每日\s*[一二三四\d]|每次|睡前|饭后|饭前|qd|bid|tid|qid|po\b)/i;

/** 结果列的「非数字」写法：尿常规、便常规里很常见 */
const TEXT_RESULT = /^(阴性|阳性|弱阳性|未检出|未见|正常|异常|±|[-+]{1,4}|trace)$/i;

/** 数值 token：允许带 < > 与箭头 */
const NUM_TOKEN = /^[<>≤≥]?\d{1,6}(?:\.\d{1,4})?$/;

/** 参考范围 token：「3.5-9.5」「<5.2」「≥60」 */
const BOUNDS_TOKEN = /^[<>≤≥]?\d+(?:\.\d+)?(?:[-~–—至到][<>≤≥]?\d+(?:\.\d+)?)?$/;

/** 带标签的参考范围：「参考范围 3.5-9.5」「正常值：<5.2」 */
const REF_LABELLED =
  /(?:参考(?:范围|值|区间|值区间)?|正常(?:范围|值))\s*[:：]?\s*[（(【\[]?\s*([<>≤≥]?\s*\d+(?:\.\d+)?\s*(?:[-~–—至到]\s*[<>≤≥]?\s*\d+(?:\.\d+)?)?)/;

/** 括号里的参考范围：「（3.5-9.5）」 */
const REF_PAREN =
  /[（(【\[]\s*([<>≤≥]?\s*\d+(?:\.\d+)?\s*(?:[-~–—至到]\s*[<>≤≥]?\s*\d+(?:\.\d+)?)?)\s*[)）】\]]/;

/**
 * 解析参考范围。
 *
 * <p>只认三种有共识的写法：区间、单边上限（&lt;5.2）、单边下限（&gt;60）。
 * 单独一个数字（「参考范围 5」）不猜它是上限还是下限 —— 猜错比不判断更糟。
 */
export function parseBounds(text: string): { low: number | null; high: number | null } | null {
  const t = text.replace(/\s+/g, '');
  if (!t) return null;

  const range = /^([<>≤≥]?)(\d+(?:\.\d+)?)[-~–—至到]([<>≤≥]?)(\d+(?:\.\d+)?)$/.exec(t);
  if (range) {
    const low = Number(range[2]);
    const high = Number(range[4]);
    if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
    // 区间写反了就按大小归位，不改变含义
    return low <= high ? { low, high } : { low: high, high: low };
  }

  const oneSide = /^([<>≤≥])(\d+(?:\.\d+)?)$/.exec(t);
  if (oneSide) {
    const n = Number(oneSide[2]);
    if (!Number.isFinite(n)) return null;
    return oneSide[1] === '<' || oneSide[1] === '≤'
      ? { low: null, high: n }
      : { low: n, high: null };
  }

  return null;
}

/** 箭头 / H、L 标记直接说明高低，优先于数值比较 */
function arrowFlag(line: string): LabFlag | null {
  if (/[↑▲]|\(\s*高\s*\)|（\s*高\s*）/.test(line)) return 'high';
  if (/[↓▼]|\(\s*低\s*\)|（\s*低\s*）/.test(line)) return 'low';
  // H/L 只认独立出现的大小写单字母（"10^9/L" 里的 L 不能算）
  if (/(?:^|\s)H(?:\s|$)/.test(line)) return 'high';
  if (/(?:^|\s)L(?:\s|$)/.test(line)) return 'low';
  return null;
}

/** 与参考范围比较。只比区间，不解释 */
export function judgeResult(
  result: string,
  low: number | null,
  high: number | null,
  arrow: LabFlag | null = null,
): LabFlag {
  if (arrow) return arrow;
  const n = Number(result.replace(/[<>≤≥]/g, ''));
  if (!Number.isFinite(n)) return 'unknown';
  if (low === null && high === null) return 'unknown';
  if (high !== null && n > high) return 'high';
  if (low !== null && n < low) return 'low';
  return 'normal';
}

/** 判断一个名字像不像化验项目 */
function plausibleName(name: string): boolean {
  if (name.length < 2 || name.length > 24) return false;
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(name)) return false;
  /*
   * 名字里不能有数字。
   *
   * 门诊记录里常有「血压152/94mmHg，空腹血糖 7.6 mmol/L」这种连写，
   * 允许数字就会把前半句整段当成项目名，读出一条根本不存在的结果。
   */
  if (/\d/.test(name)) return false;
  if (MED_NAME.test(name)) return false;
  if (NOISE_LINE.test(name)) return false;
  // 纯单位 / 纯英文缩写以外的东西：至少有一个中文或 3 个以上字母
  if (/^[\u4e00-\u9fa5]{2,}$/.test(name)) return true;
  return /[A-Za-z]{2,}/.test(name) || /[\u4e00-\u9fa5]/.test(name);
}

/** 解析一行。读不出来返回 null */
function parseLine(raw: string): LabValue | null {
  const original = raw.trim();
  if (!original) return null;
  if (NOISE_LINE.test(original)) return null;
  if (MED_LINE.test(original)) return null;

  let line = original;
  let refText: string | null = null;

  const labelled = REF_LABELLED.exec(line);
  const paren = labelled ? null : REF_PAREN.exec(line);
  const refMatch = labelled ?? paren;
  if (refMatch) {
    refText = refMatch[1]!.replace(/\s+/g, '');
    line = `${line.slice(0, refMatch.index)} ${line.slice(refMatch.index + refMatch[0].length)}`;
  }

  const arrow = arrowFlag(original);

  /*
   * 用空白与冒号切 token。
   *
   * 化验单的列之间至少有一个空格（「白细胞计数 6.2 10^9/L」），
   * 中文项目名内部没有空格，所以这个切法是安全的。
   */
  const tokens = line
    .split(/[\s:：]+/)
    // 去掉粘在 token 两端的标点（「g/L（」这种是删参考范围后留下的括号）
    .map((t) => t.replace(/^[\s（(【\[，,；;]+|[\s，,；;()（）【】\[\]]+$/g, ''))
    .filter(Boolean);

  if (tokens.length < 2) return null;

  /*
   * 有的排版把数值和单位粘在一起（「6.2×10^9/L」「128g/L」），
   * 没有空格可分。先把它拆成「数值 + 单位」两个 token 再继续。
   */
  const GLUED = /^([<>≤≥]?\d{1,6}(?:\.\d{1,4})?)((?:[A-Za-z%μ]|×).*)$/;
  const gluedIdx = tokens.findIndex((t) => GLUED.test(t));
  if (gluedIdx > 0) {
    const m = GLUED.exec(tokens[gluedIdx]!)!;
    const unitPart = m[2]!.replace(/^×/, '').replace(/[（(【\[]+$/, '');
    tokens.splice(gluedIdx, 1, m[1]!, unitPart);
  }

  // 名字 = 数值之前的全部 token（防止「平均红细胞 体积」被切开的极端情况）
  let valueIdx = tokens.findIndex((t) => NUM_TOKEN.test(t));
  let name = '';
  let result = '';
  let rest: string[] = [];

  if (valueIdx > 0) {
    name = tokens.slice(0, valueIdx).join('');
    result = tokens[valueIdx]!.replace(/[↑↓▲▼]/g, '');
    rest = tokens.slice(valueIdx + 1);
  } else if (tokens.length >= 2 && TEXT_RESULT.test(tokens[1]!.replace(/[↑↓▲▼]/g, ''))) {
    // 定性结果：「尿蛋白 阴性 阴性(-)」
    valueIdx = 1;
    name = tokens[0]!;
    result = tokens[1]!.replace(/[↑↓▲▼]/g, '');
    rest = tokens.slice(2);
  } else {
    return null;
  }

  name = name.replace(/[（(].*?[)）]/g, '').trim();
  if (!plausibleName(name)) return null;
  if (!NUM_TOKEN.test(result) && !TEXT_RESULT.test(result)) return null;

  let unit: string | null = null;
  let bounds: { low: number | null; high: number | null } | null = refText
    ? parseBounds(refText)
    : null;

  for (const tok of rest) {
    if (/^(参考|正常值|提示|单位|结果)/.test(tok)) continue;
    if (BOUNDS_TOKEN.test(tok) && /[-~–—至到<>≤≥]/.test(tok) && !bounds) {
      // 没写「参考范围」标签时，区间形式的 token 就是参考范围
      const b = parseBounds(tok);
      if (b) {
        bounds = b;
        refText = tok;
        continue;
      }
    }
    // 结果后面第一个非数值 token 是单位（「10^9/L」「%」「g/L」）
    if (!unit && !NUM_TOKEN.test(tok) && !TEXT_RESULT.test(tok) && !DOSE_UNIT.test(tok)) unit = tok;
  }

  return {
    name,
    result,
    unit,
    refText,
    refLow: bounds?.low ?? null,
    refHigh: bounds?.high ?? null,
    flag: judgeResult(result, bounds?.low ?? null, bounds?.high ?? null, arrow),
  };
}

/**
 * 从报告文本里读出所有数值条目。
 *
 * <p>同一项目名重复出现时只保留第一条 —— 化验单常在页眉与正文各写一遍，
 * 也可能在「提示」里复述异常项，重复列出会让患者以为做了两次。
 */
export function parseLabValues(text: string): LabValue[] {
  const src = (text ?? '').trim();
  if (!src) return [];

  const out: LabValue[] = [];
  const seen = new Set<string>();

  for (const line of src.split(/\n+/)) {
    const row = parseLine(line);
    if (!row) continue;
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    out.push(row);
  }

  return out;
}

/** 汇总：总数 + 高于 / 低于的条数 */
export function summarizeLabValues(rows: LabValue[]): LabValueSummary {
  return {
    rows,
    high: rows.filter((r) => r.flag === 'high').length,
    low: rows.filter((r) => r.flag === 'low').length,
  };
}
