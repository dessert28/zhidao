/* ------------------------------------------------------------------
 * 图像识别的客户端封装
 *
 * 与 PDF/文本路径的关键区别必须在这里说清楚：
 *   PDF 与文本：原文永不离开设备
 *   图像：**图片会发送给模型服务商**才能被识别
 *
 * 这个区别不是实现偷懒，是物理限制 —— 像素没法在浏览器里"脱敏"，
 * 识别必须发生在能看到图的地方。
 *
 * 所以这个模块除了调接口，还负责把这件事**如实传达给用户**：
 * 界面文案由调用方从 `IMAGE_PRIVACY_NOTICE` 取，不在这里硬编码。
 * ------------------------------------------------------------------ */

import type { BackendFailure } from '../api';

/** 界面必须展示的隐私说明。写成常量是为了保证"每处都显示同一句话" */
export const IMAGE_PRIVACY_NOTICE =
  '图片会发送给模型服务商用于识别，这是唯一一条原图离开设备的路径。' +
  '建议上传前先遮住姓名、就诊卡号等手写内容。';

export interface RecognizedItem {
  name: string;
  value: string;
  reference?: string;
}

export type ImageOcrResult =
  | { ok: true; items: RecognizedItem[]; text: string; maskedCount: number }
  | { ok: false; message: string; failure?: BackendFailure };

/** 图片大小上限，与后端一致 */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * 识别一张报告图。
 *
 * <p>base64 在浏览器端转换：用 FileReader 读成 data URL 再切掉前缀。
 * 不用 fetch(file) —— 那条路需要额外的 blob 生命周期管理，
 * 而且看不出编码错误。
 */
export async function recognizeImage(file: File): Promise<ImageOcrResult> {
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
    return { ok: false, message: `暂不支持 ${file.type || '这种'} 格式。请提供 PNG / JPG / WebP。` };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, message: `图片超过 ${MAX_BYTES / 1024 / 1024} MB，请压缩后再上传。` };
  }

  let base64: string;
  try {
    base64 = await toBase64(file);
  } catch {
    return { ok: false, message: '图片读取失败，请重试。' };
  }

  let res: Response;
  try {
    res = await fetch('/api/ocr/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base64, mimeType: file.type, byteSize: file.size }),
    });
  } catch {
    return {
      ok: false,
      message: '前端服务未响应，请确认 pnpm dev 正在运行。',
      failure: { kind: 'unreachable', message: '前端服务未响应' },
    };
  }

  if (!res.ok) {
    return { ok: false, message: `识别服务返回 ${res.status}，请稍后重试。` };
  }

  const body = (await res.json().catch(() => null)) as
    | { ok: true; items: RecognizedItem[]; text: string; maskedCount: number }
    | { ok: false; message: string }
    | null;

  if (!body) {
    return { ok: false, message: '返回内容无法解析，请稍后重试。' };
  }
  if (!body.ok) {
    return { ok: false, message: body.message };
  }
  return { ok: true, items: body.items, text: body.text, maskedCount: body.maskedCount };
}

/** File → base64（不含 data: 前缀） */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r !== 'string') {
        reject(new Error('unexpected result type'));
        return;
      }
      // "data:image/png;base64,XXXX" → "XXXX"
      const comma = r.indexOf(',');
      resolve(comma >= 0 ? r.slice(comma + 1) : r);
    };
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
