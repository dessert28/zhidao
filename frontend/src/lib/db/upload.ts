/* ------------------------------------------------------------------
 * 病历上传处理 —— 隐私边界在这条链路上真正跑起来
 *
 * ============ 数据流（两阶段，①→②→③ 的顺序不能改） ============
 *
 *   选文件
 *     ↓
 *   prepareUpload：读成文本 → 本地 redact() → 抽草稿
 *     ↓                         ↑ 不写 IndexedDB、不调后端
 *   患者校对 / 手改草稿
 *     ↓
 *   confirmUpload：① 原文存 IndexedDB   ← 永不离开设备
 *                  ② 本地 redact() 脱敏
 *                  ③ 只把脱敏文本 POST 给后端
 *
 * 为什么拆成两阶段：抽取结果会驱动到院导航，错一项就把人指错楼层。
 * 患者必须在提交前看到"系统从我的文件里读出了什么"，并能改。
 *
 * ①②③ 的顺序仍是硬约束：
 *   先脱敏再存原文的话，本地只剩脱敏版，患者看不到自己上传的到底是什么；
 *   先上传再脱敏的话，原文已经出去了 —— 整个隐私架构作废。
 *
 * **PDF 走完全相同的链路**：提取出来的文字同样先进 IndexedDB 再脱敏。
 * 多一种输入格式不该让隐私边界退化。
 *
 * ============ 不假装支持 ============
 *
 * 支持：纯文本（.txt/.md）、**文本型 PDF**（电子病历、自助机打印的化验单）。
 * 不支持：扫描型 PDF（页面里只有图，没有文字对象）、图片。
 *
 * 扫描件会明确报错而不是返回空字符串 ——
 * 后者会让患者看到"处理成功"但病历是空的，以为系统坏了。
 * ------------------------------------------------------------------ */

import { saveRecord, listRecords, type LocalRecord } from './records';
import { redact } from '../privacy/redact';
import { extractDraft, BRIEF_LIMIT, type ExtractionDraft } from '../exam/extract';
import type { ParsedExam } from '../exam/order-parse';
import { createRecord, type BackendFailure } from '../api';

export interface UploadInput {
  file: File;
  /** 患者填的就诊日期 YYYY-MM-DD */
  visitDate: string;
  /** 院区编码 */
  hospitalCode: string;
  department?: string;
  /**
   * 这份材料是什么。
   *
   * <p>默认 `record`（既往病历）。选 `examOrder` 时，
   * 除了照常走隐私链路，还会把文本解析成检查项目存到本地 ——
   * 到院页据此重算"接下来去哪几站"。
   *
   * <p>为什么解析在**本地**做：检查单里可能有门诊号等手写标注。
   * 解析只为了算路线，没必要把结构化结果传到服务端；
   * 上传给后端的仍然只有脱敏文本。
   */
  kind?: 'record' | 'examOrder';
}

export type UploadResult =
  | { ok: true; localId: string; redactedLength: number; maskedCount: number }
  | {
      ok: false;
      stage: 'read' | 'unsupported' | 'local' | 'backend';
      message: string;
      failure?: BackendFailure;
    };

/** 直接当纯文本读的扩展名 */
const TEXT_EXT = /\.(txt|md|text)$/i;

/**
 * 把文件读成文本。
 *
 * <p>三种输入走不同路径，但**输出汇合到同一条隐私链路**：
 * 纯文本直接读，PDF 提取文字，图片走 VLM 识别。
 * 这一层不区分来源，之后的存原文与脱敏逻辑完全一致。
 *
 * <p><b>但图片有一个本质区别必须在界面上说明</b>：
 * 文本与 PDF 的原文从不离开设备，而图片**必须发给模型服务商**
 * 才能被识别。文案见 `ocr.ts` 的 `IMAGE_PRIVACY_NOTICE`。
 */
async function readAsText(
  file: File,
): Promise<{ ok: true; text: string } | { ok: false; stage: 'read' | 'unsupported'; message: string }> {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  const isText = TEXT_EXT.test(file.name) || file.type.startsWith('text/');
  const isImage = /^image\//i.test(file.type);

  if (isImage) {
    // 动态 import：识别封装与后续依赖只在选图时加载
    const { recognizeImage } = await import('./ocr');
    const r = await recognizeImage(file);
    if (!r.ok) {
      return { ok: false, stage: 'unsupported', message: r.message };
    }
    /*
     * 用识别出的文本走后续链路。
     * 注意这里的 text 已经过服务端 redact 兜底（见 routes/ocr.ts），
     * 但前端仍会再脱敏一次 —— 两道不为过。
     */
    return { ok: true, text: r.text };
  }

  if (isPdf) {
    // 动态 import：pdfjs 有数百 KB（含 worker），不进首屏
    const { extractPdfText } = await import('./pdf');
    const r = await extractPdfText(file);
    if (!r.ok) {
      /*
       * scanned / broken / empty 三种都归到 unsupported：
       * 从用户视角都是"这个文件处理不了"，但各自话术不同
       * （扫描件提示手动录入、加密提示导出无密码版）。
       */
      return { ok: false, stage: 'unsupported', message: r.message };
    }
    return { ok: true, text: r.text };
  }

  if (isText) {
    try {
      return { ok: true, text: await file.text() };
    } catch {
      return { ok: false, stage: 'read', message: '文件读取失败，请重试或换一个文件。' };
    }
  }

  return {
    ok: false,
    stage: 'unsupported',
    message: `暂不支持「${file.name}」这种格式。当前支持纯文本（.txt/.md）、文本型 PDF 与报告图（PNG/JPG/WebP）。`,
  };
}

/**
 * 第一阶段的结果 —— 只有草稿，没有任何副作用。
 *
 * <p>失败只可能发生在"读/格式"两步：这一阶段不碰 IndexedDB，也不调后端。
 */
export type PrepareResult =
  | { ok: true; draft: ExtractionDraft }
  | { ok: false; stage: 'read' | 'unsupported'; message: string };

/**
 * 第一阶段：读文件、脱敏、抽草稿。
 *
 * <p><b>不写 IndexedDB，不调后端。</b>
 * 患者还没点「确认保存」时，任何持久化或上传都等于替他做了决定 ——
 * 尤其检查项目会改到院路线，不能先存了再让他取消。
 *
 * <p>图片走 OCR 时这里会调用识别服务（见 {@link readAsText}）。
 * 那是"把图变成文字"的必要步骤，不是病历上传；
 * 纯文本与 PDF 在这一阶段完全零网络。
 */
export async function prepareUpload(input: UploadInput): Promise<PrepareResult> {
  const { file, kind = 'record' } = input;

  /* ---- 1. 读取文本 ---- */
  const read = await readAsText(file);
  if (!read.ok) return read;

  const rawText = read.text;
  if (!rawText.trim()) {
    return { ok: false, stage: 'read', message: '这个文件里没有可用的文字内容。' };
  }

  /*
   * 先脱敏再抽摘要。
   *
   * <p>顺序不能反：摘要会展示给患者、也会成为提交内容，
   * 从原文截取会把身份证号、手机号一起带进草稿。
   * 这里算出的 safeText 也交给 extractDraft 复用，
   * 避免对大文件重复扫一遍脱敏规则。
   */
  const { text: safeText } = redact(rawText);
  const draft = extractDraft(rawText, { kind, redactedText: safeText });

  return { ok: true, draft };
}

/**
 * 第二阶段：按患者确认后的草稿真正落库并提交。
 *
 * <p>这里会**重新读一次文件**，而不是把原文挂在草稿里传过来。原因：
 * <ol>
 *   <li>草稿会进 React state，可能被调试工具、日志序列化，原文不该跟着走；</li>
 *   <li>`ocrText` 必须由原文重新脱敏生成，不能拿用户改过的摘要冒充原文；</li>
 *   <li>上传与确认之间文件可能已被替换/删除，重新读能如实报错。</li>
 * </ol>
 *
 * <p>代价是图片会再走一次 OCR。这是当前实现里唯一可感知的重复开销，
 * 换的是"原文不进入任何 UI 状态"这条更重要的边界。
 */
export async function confirmUpload(
  input: UploadInput,
  draft: ExtractionDraft,
): Promise<UploadResult> {
  const { file, visitDate, hospitalCode, department } = input;

  /*
   * 类型以 input 为准，但只在该类型下使用 examItems。
   * 两者不一致说明界面漏了重置（比如切了类型却没重新解析）——
   * 此时宁可丢掉项目，也不能把检查单的项目塞进一份普通病历。
   */
  const kind = input.kind ?? draft.kind;

  const read = await readAsText(file);
  if (!read.ok) return read;

  const rawText = read.text;
  if (!rawText.trim()) {
    return { ok: false, stage: 'read', message: '这个文件里没有可用的文字内容。' };
  }

  /*
   * 检查项目用**患者编辑后的版本**：改名、删除、新增都以界面为准。
   * 空名字的行是用户新增后没填完的，直接丢弃 ——
   * 存一个空项目会让到院页多出一站没有名字的检查。
   */
  const examItems: ParsedExam[] | undefined =
    kind === 'examOrder'
      ? draft.examItems
          .map((it) => ({ ...it, name: it.name.trim() }))
          .filter((it) => it.name.length > 0)
      : undefined;

  /* ---- ① 原文存本地（永不上传） ---- */
  const localId = await saveRecord({
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'text/plain',
    rawText,
    visitDate,
    hospitalCode,
    department: department ?? '',
    kind,
    // 空数组也保留：用户确认"这一单没有识别出项目"本身是有信息量的
    ...(examItems ? { examItems } : {}),
  });
  if (!localId) {
    return {
      ok: false,
      stage: 'local',
      message: '本地存储不可用（可能是浏览器隐私模式），无法保存原文。为保护隐私，本次不上传。',
    };
  }

  /* ---- ② 本地脱敏，只把结果发出去 ---- */
  const { text: safeText, hits } = redact(rawText);

  /*
   * 摘要用编辑后的版本，但仍然过一次 redact：
   * 患者可能把手机号粘进摘要框，而这个字段是作为独立字段发出去的，
   * 不经过 ocrText 的脱敏。
   *
   * <p>注意 ocrText 必须来自上面的**原文**脱敏 ——
   * 绝不能拿编辑后的摘要当原文去脱敏，那样文件里其余 PII 全会漏掉。
   */
  const safeBrief = redact(draft.diagnosisBrief.trim()).text.slice(0, BRIEF_LIMIT);

  /*
   * 发出去的字段名叫 `ocrText`（后端 schema 的列名），
   * 但它装的是**脱敏后**的文本。这个对应关系必须写清楚，
   * 否则下一个人会以为这里是原文。
   */
  const r = await createRecord({
    hospitalCode,
    visitDate,
    department: department ?? null,
    diagnosisBrief: safeBrief,
    ocrText: safeText,
    fileName: file.name,
    fileSize: file.size,
  });

  if (!r.ok) {
    return {
      ok: false,
      stage: 'backend',
      // 原文已经在本地了，所以这不是数据丢失 —— 明确告诉患者
      message: `原文已保存在本机，但提交摘要失败：${
        r.failure.kind === 'unreachable' ? '后端未启动' : '服务异常'
      }。可以稍后在列表里重试。`,
      failure: r.failure,
    };
  }

  return { ok: true, localId, redactedLength: safeText.length, maskedCount: hits.length };
}

/**
 * 兼容入口：老调用方（以及现有测试）只想要"一步上传"。
 *
 * <p>内部就是 prepare + 直接确认，没有任何校对。
 * 新界面请分开调用，否则患者又失去了核对的机会。
 */
export async function uploadRecord(input: UploadInput): Promise<UploadResult> {
  const prepared = await prepareUpload(input);
  if (!prepared.ok) return prepared;
  return confirmUpload(input, prepared.draft);
}

/** 列本地原文（给"我上传过什么"用） */
export async function listLocalRecords(): Promise<LocalRecord[]> {
  return listRecords();
}
