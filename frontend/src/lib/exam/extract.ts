/* ------------------------------------------------------------------
 * 上传草稿抽取 —— 把「读完文件」和「提交」之间空出来的那一步补上
 *
 * ============ 为什么需要草稿 ============
 *
 * 之前 `uploadRecord()` 是一步到位的：读完文件就直接存库并提交。
 * 患者没有机会发现"系统把我的主诉截成了一串乱码"或
 * "检查单上的腹部彩超没被识别出来"。
 *
 * 抽取结果会直接驱动到院页的导航，错一项就可能把人指错楼层，
 * 所以必须先把草稿摆出来让患者核对、修改，再决定提交什么。
 *
 * ============ 这是规则抽取，不是医学 NLP ============
 *
 * 本模块只做两件确定性的事：
 *   1. 用正则脱敏后截取前 200 字作为摘要
 *   2. 复用 `parseExamOrder` 的词典匹配抽取检查项目
 *
 * 写「遵医嘱」「按原计划复查」这类自由文本时**什么都抽不到**，
 * 此时如实返回空字符串/空数组，界面会提示"以原文为准"。
 * 不假装解析成功 —— 假装成功比明确失败更危险：
 * 患者会以为系统看懂了，从而不再核对。
 * ------------------------------------------------------------------ */

import { parseExamOrder, type ParsedExam } from './order-parse';
import { redact } from '../privacy/redact';

/** 这份材料是既往病历，还是医生开的检查单 */
export type RecordKind = 'record' | 'examOrder';

/** 摘要最多保留多少字。界面与提交字段共用这个上限，避免两处漂移 */
export const BRIEF_LIMIT = 200;

export interface ExtractMeta {
  /** 材料类型。只有检查单才解析检查项目，病历不解析（见下） */
  kind?: RecordKind;
  /**
   * 调用方已经算好的脱敏文本。
   *
   * <p>加这个可选参数是为了让 `prepareUpload` 不必对同一份原文
   * 扫两遍脱敏规则（大文件上那是纯浪费），同时保证摘要与
   * 真正提交的 `ocrText` 来自同一次脱敏结果。
   *
   * <p>不传时本函数自己脱敏，因此它仍是可以单独调用的纯函数。
   */
  redactedText?: string;
}

/** 给患者校对的上传草稿 */
export interface ExtractionDraft {
  /** 草稿是按哪种材料类型抽的。界面据此决定展示哪些部分 */
  kind: RecordKind;
  /**
   * 诊断 / 主诉摘要。
   *
   * <p>来自**脱敏后**的文本：这个字段会被直接展示，也会被提交给后端，
   * 从原文截取会把身份证号、手机号一起带出去。
   */
  diagnosisBrief: string;
  /**
   * 规则抽到的检查项目（直接复用 `parseExamOrder`，不另建词典）。
   *
   * <p>仅 `kind === 'examOrder'` 时有值。既往病历里的
   * 「空腹血糖 8.4」是**检查结果**，不是"接下来要做的项目"；
   * 把它当检查项目存下来，到院页会凭空多出一站。
   */
  examItems: ParsedExam[];
}

/**
 * 从病历文本生成可校对草稿。
 *
 * @param rawText 文件读出来的原文（未脱敏）
 * @param meta    材料类型，以及调用方已算好的脱敏文本
 */
export function extractDraft(rawText: string, meta: ExtractMeta = {}): ExtractionDraft {
  const kind = meta.kind ?? 'record';
  // 摘要必须基于脱敏文本；调用方传了就直接用，省一次全文扫描
  const safeText = meta.redactedText ?? redact(rawText).text;

  return {
    kind,
    diagnosisBrief: buildBrief(safeText),
    /*
     * 检查项目仍用**原文**解析。理由有两条：
     *   1. 项目名（"胸部 CT""血常规"）本身不含 PII，脱敏不会改变识别结果；
     *   2. 解析结果只写进本地 IndexedDB，给到院页算路线用，不上传。
     * 与改造前的 `uploadRecord` 行为保持一致。
     */
    examItems: kind === 'examOrder' ? parseExamOrder(rawText) : [],
  };
}

/**
 * 压缩空白后截取摘要。
 *
 * <p>病历原文的换行会撑高时间轴卡片，而摘要只用于列表里的一行预览，
 * 所以把所有连续空白压成单个空格。截断按 `BRIEF_LIMIT` 而不是
 * "前 200 个字符"写死，界面上的字数提示才不会与这里对不上。
 */
function buildBrief(safeText: string): string {
  return safeText.replace(/\s+/g, ' ').trim().slice(0, BRIEF_LIMIT);
}
