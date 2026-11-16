/* ------------------------------------------------------------------
 * 报告图识别路由 —— POST /api/ocr/report
 *
 * ============ 这条路径与别处的本质区别 ============
 *
 * 其他所有路径的原文都不离开设备（文本走前端 redact，
 * PDF 在浏览器里提取后同样先脱敏）。
 * **图片做不到这一点** —— 像素没法在浏览器里"脱敏"，
 * 识别必须发生在能看到图的地方。
 *
 * 所以这里的选择是：
 *   图片 → BFF（内存中转发给模型）→ 识别结果（文本）
 *   → **立刻在这里做一次 redact 兜底** → 返回给前端
 *
 * 为什么 BFF 还要再脱敏一次（前端已经会脱敏）：
 *   ocrText 直接来自模型，前端拿到后如果忘了脱敏就入库，
 *   等于把模型可能抄进来的姓名原样落库。
 *   在服务端出关口再挡一道，比信任调用方稳妥。
 *
 * ============ 图片不落盘 ============
 *
 * 全程只在内存里走，不写临时文件、不记日志内容。
 * 出问题时日志里只有 mimeType 与字节数，没有图片数据。
 * ------------------------------------------------------------------ */

import { Hono } from 'hono';
import { recognizeReportImage } from '../ocr/recognize.js';
import { redact } from '../../src/lib/privacy/redact.js';

export const ocrRoutes = new Hono();

/** 请求体上限：4MB 图片 base64 后约 5.4MB，留余量 */
const MAX_BODY = 6 * 1024 * 1024;

interface OcrBody {
  /** base64，不含 data: 前缀 */
  base64: string;
  mimeType: string;
  byteSize: number;
}

ocrRoutes.post('/report', async (c) => {
  let body: OcrBody;
  try {
    body = await c.req.json<OcrBody>();
  } catch {
    return c.json({ ok: false, message: 'invalid_json' }, 400);
  }

  if (!body?.base64 || !body.mimeType) {
    return c.json({ ok: false, message: 'base64 与 mimeType 必填' }, 400);
  }
  if (body.base64.length > MAX_BODY) {
    return c.json({ ok: false, message: '图片过大' }, 413);
  }

  const r = await recognizeReportImage({
    base64: body.base64,
    mimeType: body.mimeType,
    byteSize: body.byteSize,
  });

  if (!r.ok) {
    // 只记原因与类型，不记图片内容
    console.warn('[ocr] 识别失败', r.reason, body.mimeType, body.byteSize);
    return c.json({ ok: false, reason: r.reason, message: r.message }, 200);
  }

  /*
   * 出关口脱敏。
   *
   * 模型可能抄进图上的姓名/手机号，这里统一遮蔽后再给前端。
   * 这样即便前端某天漏了脱敏步骤，落库的也不是原文。
   */
  const masked = redact(r.rawText);

  return c.json({
    ok: true,
    /** 报告类型：LAB / XRAY / CT / MRI / ULTRASOUND / ECG / ENDOSCOPY ... */
    kind: r.kind,
    title: r.title,
    findings: r.findings,
    conclusion: r.conclusion,
    items: r.items,
    params: r.params,
    /** 脱敏后的规范化全文，前端可直接用于入库 */
    text: masked.text,
    /** 遮蔽了几处，用于界面提示 */
    maskedCount: masked.hits.length,
  });
});
