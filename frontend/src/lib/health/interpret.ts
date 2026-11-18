/* ------------------------------------------------------------------
 * 报告解读 —— 「把报告里的词翻成白话」，仅此而已
 *
 * ============ 与 reports.ts 的分工 ============
 *
 * reports.ts 负责**抽出结构**：所见在哪、结论在哪、要不要随访。
 * 这里负责**把结构讲成人话**：这句话里有几个患者不认识的词，
 * 每个词是什么意思。
 *
 * 两者都不判断结果。区别只是：前者交付的是原文位置，
 * 后者交付的是词义。合起来构成「报告解读」，而不是「报告诊断」。
 *
 * ============ 为什么不做逐句改写 ============
 *
 * 「建议 3-6 个月复查」改写成「医生让你过几个月再来查一次」，
 * 看着更友好，但改写过程会丢掉「3-6 个月」这类关键量词 ——
 * 而漏掉时间窗，比看不懂更糟。所以原文一字不改，
 * 只在下面挂注解。
 *
 * ============ 一条硬规则 ============
 *
 * 任何地方都不出现「要紧 / 严重 / 需要治疗 / 可能是某病」。
 * 判断的权利留给写报告的医生和接诊的医生。
 * 这条规则有测试守着（glossary.test.ts 会扫描全库措辞），
 * 新增术语时如果写了判断性的话，测试会直接失败。
 * ------------------------------------------------------------------ */

import { KIND_META, parseReport, type ParsedReport, type ReportKind } from './reports';
import { findTerms, type TermHit } from './glossary';

/** 一句原文 + 它命中的术语 */
export interface InterpretedLine {
  text: string;
  terms: TermHit[];
}

export interface ReportInterpretation {
  kind: ReportKind;
  /** 展示标题，如「胸部 CT」「化验单」 */
  title: string;
  /** 分句后的原文行（结论、所见）。化验单没有段落结构时为空 */
  lines: InterpretedLine[];
  /** 全文命中的术语，按首次出现排序 */
  terms: TermHit[];
  /** 一个术语都没命中时的说明，避免界面出现空白块 */
  emptyReason: string | null;
  /** 免责脚注。按报告类型不同而不同 */
  caveat: string;
}

/** 通用脚注 */
const CAVEAT_DEFAULT =
  '以上只是把报告里出现的专业术语换成白话说法，不涉及对结果的判断。' +
  '结果意味着什么、下一步怎么做，请让开单医生或写报告的医生解释。';

/** 病理脚注：判定权只能在病理科 */
const CAVEAT_PATHOLOGY =
  '病理结论只能由病理科医生结合镜下所见给出。这里只解释术语的字面含义，' +
  '不做任何倾向性说明，请以病理报告原文和主治医生的解释为准。';

/**
 * 化验脚注。
 *
 * <p>数值本身在卡片里已经和**报告上印的参考范围**对照过并标了出来，
 * 所以这里不再把人指去别处 —— 只说明「对照的是谁的范围」和「判断归谁」。
 */
const CAVEAT_LAB =
  '这里只解释名词。数值对照的是这张报告自己印的参考范围，落在区间之外不等于有问题；' +
  '意味着什么、要不要处理，请交给开单医生。';

/** 未识别脚注 */
const CAVEAT_UNKNOWN =
  '这份材料没有识别出「所见 / 结论」这类段落，可能是扫描件不清晰、' +
  '或格式不常见。原文已完整保存在本机，可以直接给医生看。';

/**
 * 按句切分。
 *
 * <p>中文报告的句子以句号、分号为主，条目常用「1.」「2、」编号。
 * 编号要去掉 —— 注解区里出现「1. 双肺纹理清晰」会让人以为
 * 我们在重新编号，而原文的编号在卡片上方已经照录过。
 *
 * <p>只切分不合并短句：报告里「左肺上叶」单独一行的情形很常见，
 * 合并会把它和下一条不同部位的描述拼在一起，反而读错。
 */
export function splitSentences(text: string): string[] {
  if (!text?.trim()) return [];
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[。；;！!？?])/))
    .map((s) => s.replace(/^\s*(?:\d{1,2}\s*[.、)）]|[（(]\s*\d{1,2}\s*[)）])\s*/, '').trim())
    // 长度按「去掉标点后的字数」算：「无。」只有 1 个字，不该当一个句子
    .filter((s) => s.replace(/[。；;！!？?，,、\s]/g, '').length >= 2);
}

/** 标题：优先「部位 + 类型」，没有部位就用类型的完整名 */
function buildTitle(kind: ReportKind, bodyPart: string | null): string {
  const meta = KIND_META[kind];
  if (kind === 'LAB') return '化验单';
  if (!bodyPart) return meta.label;
  return `${bodyPart}${meta.short}`;
}

/**
 * 生成一份报告的解读。
 *
 * <p>传入 parsed 可以复用调用方已经解析过的结果（列表页一次解析多份时
 * 避免重复跑正则）；不传就自己解析。
 */
export function interpretReport(
  text: string,
  fileName?: string | null,
  parsed?: ParsedReport,
): ReportInterpretation {
  const src = (text ?? '').trim();
  const p = parsed ?? parseReport(src, fileName);
  /*
   * 术语扫描按**原文出现顺序**（所见在前、结论在后）。
   *
   * 不按「结论优先」排：注解列表的顺序应该跟患者眼睛扫原文的顺序一致，
   * 否则会出现「第一个注解来自最后一句」这种对不上的观感。
   */
  const scanParts = [p.findings, p.conclusion].filter((s): s is string => Boolean(s?.trim()));
  const hasSections = scanParts.length > 0;

  /*
   * 有段落就只扫段落 —— 页眉、患者信息、医师签名里的词与结果无关，
   * 扫全文会给出「张医生 — 医师姓名」这种没用的注解。
   * 没有段落（化验单、扫描件）才退回扫全文。
   */
  const scanText = hasSections ? scanParts.join('\n') : src;

  // 展示用分句仍以结论优先：患者最想知道的是那一句
  const lines: InterpretedLine[] = [];
  for (const section of [p.conclusion, p.findings]) {
    if (!section?.trim()) continue;
    for (const sentence of splitSentences(section)) {
      lines.push({ text: sentence, terms: findTerms(sentence) });
    }
  }

  const terms = findTerms(scanText);

  let emptyReason: string | null = null;
  if (!src) {
    emptyReason = '这份记录没有可读的文字内容。';
  } else if (terms.length === 0) {
    emptyReason =
      '这段文字里没有需要注解的专业术语。如果有些说法看不懂，可以在问诊里直接问，' +
      '或让开单医生解释。';
  }

  let caveat = CAVEAT_DEFAULT;
  if (p.kind === 'PATHOLOGY') caveat = CAVEAT_PATHOLOGY;
  else if (p.kind === 'LAB') caveat = CAVEAT_LAB;
  else if (!hasSections) caveat = CAVEAT_UNKNOWN;

  return {
    kind: p.kind,
    title: buildTitle(p.kind, p.bodyPart),
    lines,
    terms,
    emptyReason,
    caveat,
  };
}

/**
 * 是否值得给这份报告显示解读区块。
 *
 * <p>门诊病历（没有检查结论、也没有任何术语命中）不显示 ——
 * 一块写着「没有需要注解的术语」的区块只会占掉手机一屏。
 */
export function hasInterpretation(interp: ReportInterpretation, hasText: boolean): boolean {
  if (!hasText) return false;
  return interp.terms.length > 0 || interp.lines.length > 0;
}
