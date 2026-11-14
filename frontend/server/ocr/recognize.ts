/* ------------------------------------------------------------------
 * 报告图识别 —— VLM 读化验单
 * 依据：docs/10 D4「报告图理解（VLM 读检验单）」P1
 *
 * ============ 实测确认的能力边界 ============
 *
 * 在网关的 5 个模型上实测（2026-11-15）：
 *   deepseek-v4.1-flash  → 能准确读出图上的英文化验值与数值
 *   gpt-6.1-terra        → 对纯色图判断错误，可靠性未验证
 *   claude-sonnet-5-5    → 拒绝识图（"我没有看到图片"）
 *
 * 所以默认用主模型（deepseek）。这一点很重要：
 * 不是所有标称"多模态"的模型都真的能看图，必须实测。
 *
 * ============ 隐私：图像去哪了 ============
 *
 * **这是整个项目里唯一一个会把"非文本内容"发出设备的路径**，
 * 必须说清楚它的性质：
 *
 *   · 图片本身**不发**。前端的 redact() 是文本脱敏，处理不了图片像素。
 *   · 所以走的是：**先识别 → 再脱敏 → 才入库**。
 *     识别在 BFF 侧调 VLM，识别结果是文本，立刻走 redact()，
 *     之后与 PDF/文本路径完全一致。
 *
 *   · 也就是说，**图片会上传给模型服务商**。这是这一条路径与
 *     其他路径的本质区别 —— 文本路径的原文从不离开设备，
 *     而图片必须离开才能被识别。
 *
 * 这个取舍必须如实呈现给用户，而不是藏在说明里：
 * 界面上要明写"图片会发送给模型服务商进行识别"，
 * 并建议用户**先自行遮挡姓名等手写内容**再上传。
 * 说"我们什么都不会传"是假的，说清楚了才是可信的。
 * ------------------------------------------------------------------ */

/** 识别结果 */
export interface LabItem {
  /** 检查项目名，如「空腹血糖」 */
  name: string;
  /** 数值与单位，如「8.4 mmol/L」 */
  value: string;
  /** 参考范围（模型可能给，也可能不给） */
  reference?: string;
}

export type RecognizeResult =
  | { ok: true; items: LabItem[]; rawText: string }
  | { ok: false; reason: 'unsupported' | 'unconfigured' | 'failed'; message: string };

/** 支持的图片类型 */
const IMAGE_MIME = /^image\/(png|jpe?g|webp)$/i;

/** 图片大小上限。超过这个大小的 base64 会让请求体过大、且模型也未必看得清 */
const MAX_BYTES = 4 * 1024 * 1024;

function llmConfig(): { key: string; base: string; model: string } | null {
  const key = (process.env.LLM_API_KEY ?? '').trim();
  if (!key) return null;
  return {
    key,
    base: (process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model: (process.env.LLM_MODEL ?? 'deepseek-chat').trim(),
  };
}

/**
 * 从提示文本里抠出 JSON。
 *
 * <p>模型经常把 JSON 包在 ```json 代码块里，或者前后加一句解释。
 * 直接 JSON.parse 会失败 —— 所以先找最外层的 {...}。
 */
export function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 校验并清洗模型返回的条目 */
export function normalizeItems(raw: unknown): LabItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  const out: LabItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const value = typeof o.value === 'string' ? o.value.trim() : '';
    // 项目名与数值都为空的行没有意义，丢掉
    if (!name && !value) continue;
    out.push({
      name,
      value,
      ...(typeof o.reference === 'string' && o.reference.trim()
        ? { reference: o.reference.trim() }
        : {}),
    });
    // 一份化验单通常不超过 30 项，超出说明模型在编
    if (out.length >= 30) break;
  }
  return out;
}

export interface RecognizeInput {
  /** base64（不含 data: 前缀） */
  base64: string;
  mimeType: string;
  /** 字节数，用于大小校验 */
  byteSize: number;
}

/**
 * 调 VLM 识别报告图。
 *
 * <p>返回的是**结构化条目**而不是一段文字：
 * 后续要把它们组织进病历摘要，而结构化数据才能可靠地拼接与脱敏。
 */
export async function recognizeLabImage(input: RecognizeInput): Promise<RecognizeResult> {
  if (!IMAGE_MIME.test(input.mimeType)) {
    return {
      ok: false,
      reason: 'unsupported',
      message: `暂不支持 ${input.mimeType || '这种'} 格式的图片。请提供 PNG / JPG / WebP。`,
    };
  }
  if (input.byteSize > MAX_BYTES) {
    return {
      ok: false,
      reason: 'unsupported',
      message: `图片超过 ${MAX_BYTES / 1024 / 1024} MB，请压缩后再上传。`,
    };
  }

  const cfg = llmConfig();
  if (!cfg) {
    return {
      ok: false,
      reason: 'unconfigured',
      message: '未配置大模型，图片识别不可用。可以改用文字或 PDF 上传。',
    };
  }

  /*
   * 提示词只做一件事：**抄下来**。
   *
   * 不让模型解读、判断、给建议 —— 一旦它开始解释，
   * 我们就要为那些解释负责，而它能看到的只是图片。
   * 需要的只是把图上的字转成结构化数据，后续由我们的 Reviewer 把关。
   */
  const prompt = [
    '这是一张医疗检查报告的照片。请只做文字转录，不要解读、不要给建议。',
    '提取其中的检查项目与数值，输出 JSON：',
    '{"items":[{"name":"项目名","value":"数值+单位","reference":"参考范围（没写就省略）"}]}',
    '如果图上不是检查报告，返回 {"items":[]}。',
  ].join('\n');

  const body = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: { url: `data:${input.mimeType};base64,${input.base64}` },
          },
        ],
      },
    ],
    max_tokens: 800,
    temperature: 0,
  };

  let text: string;
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        reason: 'failed',
        message: `识别服务返回 ${res.status}。${
          res.status === 401 ? '模型密钥可能已失效。' : '可以改用文字或 PDF 上传。'
        }${detail ? `（${detail.slice(0, 80)}）` : ''}`,
      };
    }

    const j = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    text = j.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) {
      return { ok: false, reason: 'failed', message: '识别服务没有返回内容，请重试。' };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: 'failed',
      message: /timeout|abort/i.test(msg)
        ? '识别超时，图片可能过大或网络较慢。可以压缩后重试。'
        : '识别服务不可达，请稍后重试或改用文字上传。',
    };
  }

  const items = normalizeItems(extractJson(text));

  /*
   * 识别出 0 项时**不报成功**。
   *
   * 可能原因：图不是化验单、太模糊、只有手写体。
   * 直接说"识别失败，请重新拍摄或手动录入"比给一份空结果诚实。
   */
  if (items.length === 0) {
    return {
      ok: false,
      reason: 'failed',
      message: '没能从这张图里识别出检查项目。请确认图片是检查报告、拍摄清晰，或手动录入。',
    };
  }

  /*
   * rawText 是拼回来的文本形式，用于走后续的 redact() 与入库。
   * 用结构化条目的顺序拼，保证与原图顺序一致（医生看单子是按顺序看的）。
   */
  const rawText = items
    .map((it) => [it.name, it.value, it.reference ? `参考 ${it.reference}` : ''].filter(Boolean).join(' '))
    .join('\n');

  return { ok: true, items, rawText };
}
