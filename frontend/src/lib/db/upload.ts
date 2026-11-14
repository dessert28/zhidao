/* ------------------------------------------------------------------
 * 病历上传处理 —— 隐私边界在这条链路上第一次真正跑起来
 *
 * ============ 数据流（这一步的顺序不能改） ============
 *
 *   选文件
 *     ↓
 *   读成文本（只支持 .txt/.md；图片/PDF 走 OCR，当前未接）
 *     ↓
 *   ① 原文存 IndexedDB          ← 永不离开设备
 *     ↓
 *   ② 本地 redact() 脱敏
 *     ↓
 *   ③ 只把脱敏后的摘要 POST 给后端
 *
 * ①②③ 的顺序是硬约束：
 *   先脱敏再存原文的话，本地只剩脱敏版，患者看不到自己上传的到底是什么；
 *   先上传再脱敏的话，原文已经出去了 —— 整个隐私架构作废。
 *
 * ============ 为什么只支持纯文本 ============
 *
 * PDF/图片需要 OCR（浏览器里要 pdf.js + 模型），那是 P1 的事（docs/10 D4）。
 * 但**不假装支持**：选到 PDF 时明确说"当前只支持纯文本"，
 * 而不是读出一堆乱码后存进去 —— 后者会让患者以为处理成功了。
 * ------------------------------------------------------------------ */

import { saveRecord, listRecords, type LocalRecord } from './records';
import { redact } from '../privacy/redact';
import { createRecord, type BackendFailure } from '../api';

export interface UploadInput {
  file: File;
  /** 患者填的就诊日期 YYYY-MM-DD */
  visitDate: string;
  /** 院区编码 */
  hospitalCode: string;
  department?: string;
}

export type UploadResult =
  | { ok: true; localId: string; redactedLength: number; maskedCount: number }
  | { ok: false; stage: 'read' | 'unsupported' | 'local' | 'backend'; message: string; failure?: BackendFailure };

/** 当前支持的扩展名。见文件头"不假装支持" */
const TEXT_EXT = /\.(txt|md|text)$/i;

export async function uploadRecord(input: UploadInput): Promise<UploadResult> {
  const { file, visitDate, hospitalCode, department } = input;

  /* ---- 1. 只接受纯文本 ---- */
  if (!TEXT_EXT.test(file.name) && !file.type.startsWith('text/')) {
    return {
      ok: false,
      stage: 'unsupported',
      message: `暂不支持「${file.name}」这种格式。当前只处理纯文本（.txt/.md），PDF 与图片识别在规划中。`,
    };
  }

  /* ---- 2. 读原文 ---- */
  let rawText: string;
  try {
    rawText = await file.text();
  } catch {
    return { ok: false, stage: 'read', message: '文件读取失败，请重试或换一个文件。' };
  }
  if (!rawText.trim()) {
    return { ok: false, stage: 'read', message: '这个文件是空的。' };
  }

  /* ---- 3. 原文存本地（永不上传） ---- */
  const localId = await saveRecord({
    fileName: file.name,
    fileSize: file.size,
    mimeType: file.type || 'text/plain',
    rawText,
    visitDate,
    hospitalCode,
    department: department ?? '',
  });
  if (!localId) {
    return {
      ok: false,
      stage: 'local',
      message: '本地存储不可用（可能是浏览器隐私模式），无法保存原文。为保护隐私，本次不上传。',
    };
  }

  /* ---- 4. 本地脱敏，只把结果发出去 ---- */
  const { text: safeText, hits } = redact(rawText);

  /*
   * 发出去的字段名叫 `ocrText`（后端 schema 的列名），
   * 但它装的是**脱敏后**的文本。这个对应关系必须写清楚，
   * 否则下一个人会以为这里是原文。
   */
  const r = await createRecord({
    hospitalCode,
    visitDate,
    department: department ?? null,
    diagnosisBrief: safeText.slice(0, 200),
    ocrText: safeText,
    fileName: file.name,
    fileSize: file.size,
  });

  if (!r.ok) {
    return {
      ok: false,
      stage: 'backend',
      // 原文已经在本地了，所以这不是数据丢失 —— 明确告诉患者
      message: `原文已保存在本机，但提交摘要失败：${r.failure.kind === 'unreachable' ? '后端未启动' : '服务异常'}。可以稍后在列表里重试。`,
      failure: r.failure,
    };
  }

  return { ok: true, localId, redactedLength: safeText.length, maskedCount: hits.length };
}

/** 列本地原文（给"我上传过什么"用） */
export async function listLocalRecords(): Promise<LocalRecord[]> {
  return listRecords();
}
