/* ------------------------------------------------------------------
 * 病历上传处理 —— 隐私边界在这条链路上真正跑起来
 *
 * ============ 数据流（这一步的顺序不能改） ============
 *
 *   选文件
 *     ↓
 *   读成文本（.txt/.md 直接读；文本型 PDF 用 pdfjs 提取文字）
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
 * <p>两种输入走不同路径，但**输出汇合到同一条隐私链路**。
 * 这一层不区分来源，所以隐私边界不会因为多了 PDF 而退化。
 */
async function readAsText(
  file: File,
): Promise<{ ok: true; text: string } | { ok: false; stage: 'read' | 'unsupported'; message: string }> {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  const isText = TEXT_EXT.test(file.name) || file.type.startsWith('text/');

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
    message: `暂不支持「${file.name}」这种格式。当前支持纯文本（.txt/.md）与文本型 PDF；图片识别在规划中。`,
  };
}

export async function uploadRecord(input: UploadInput): Promise<UploadResult> {
  const { file, visitDate, hospitalCode, department } = input;

  /* ---- 1. 读取文本 ---- */
  const read = await readAsText(file);
  if (!read.ok) {
    return { ok: false, stage: read.stage, message: read.message };
  }
  const rawText = read.text;

  if (!rawText.trim()) {
    return { ok: false, stage: 'read', message: '这个文件里没有可用的文字内容。' };
  }

  /* ---- 2. 原文存本地（永不上传） ---- */
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

  /* ---- 3. 本地脱敏，只把结果发出去 ---- */
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
      message: `原文已保存在本机，但提交摘要失败：${
        r.failure.kind === 'unreachable' ? '后端未启动' : '服务异常'
      }。可以稍后在列表里重试。`,
      failure: r.failure,
    };
  }

  return { ok: true, localId, redactedLength: safeText.length, maskedCount: hits.length };
}

/** 列本地原文（给"我上传过什么"用） */
export async function listLocalRecords(): Promise<LocalRecord[]> {
  return listRecords();
}
