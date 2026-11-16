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

/** 检查报告类型（与前端 lib/health/reports.ts 的 ReportKind 对齐） */
export type ReportKindHint =
  | 'LAB'
  | 'XRAY'
  | 'CT'
  | 'MRI'
  | 'ULTRASOUND'
  | 'ECG'
  | 'ENDOSCOPY'
  | 'PATHOLOGY'
  | 'OTHER';

const ALLOWED_KINDS: ReportKindHint[] = [
  'LAB', 'XRAY', 'CT', 'MRI', 'ULTRASOUND', 'ECG', 'ENDOSCOPY', 'PATHOLOGY', 'OTHER',
];

/** 化验单的一行：项目名 + 数值 + 参考范围 */
export interface LabItem {
  /** 检查项目名，如「空腹血糖」 */
  name: string;
  /** 数值与单位，如「8.4 mmol/L」 */
  value: string;
  /** 参考范围（模型可能给，也可能不给） */
  reference?: string;
}

/** 客观参数：心电图的心率/PR/QRS，超声的测量值 */
export interface ParamItem {
  name: string;
  value: string;
}

/**
 * 识别结果。
 *
 * <p><b>为什么不是只有 items</b>：X 线、CT、彩超、心电图不是数值型的。
 * 它们的内容是「所见」一段描述 + 「诊断」一句结论 —— 用 items 表
 * 强行装进去只会得到一堆散落的短语。所以按报告类型分别承载。
 */
export type RecognizeResult =
  | {
      ok: true;
      kind: ReportKindHint;
      /** 检查名称，如「胸部 CT 平扫」 */
      title: string | null;
      /** 所见 / 表现 / 描述 */
      findings: string | null;
      /** 结论 / 诊断 / 提示 */
      conclusion: string | null;
      /** 化验数值（其他类型为空） */
      items: LabItem[];
      /** 客观参数（心电图、超声测量值） */
      params: ParamItem[];
      /**
       * 规范化后的全文，可直接入库为 ocrText。
       *
       * <p>之所以还要拼一段文本：下游的解析（lib/health/reports.ts）
       * 与病历时间轴都基于文本工作。结构化字段给人看，
       * 文本给程序继续处理 —— 两者都要。
       */
      rawText: string;
    }
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

/** 清洗模型返回的参数列表 */
export function normalizeParams(raw: unknown): ParamItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const params = (raw as { params?: unknown }).params;
  if (!Array.isArray(params)) return [];

  const out: ParamItem[] = [];
  for (const p of params) {
    if (!p || typeof p !== 'object') continue;
    const o = p as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const value = typeof o.value === 'string' ? o.value.trim() : '';
    if (!name || !value) continue;
    out.push({ name, value });
    if (out.length >= 10) break;
  }
  return out;
}

/** 清洗类型：模型可能返回中文或写错，统一收敛到白名单 */
export function normalizeKind(raw: unknown): ReportKindHint {
  if (!raw || typeof raw !== 'object') return 'OTHER';
  const k = (raw as { kind?: unknown }).kind;
  if (typeof k !== 'string') return 'OTHER';
  const up = k.trim().toUpperCase().replace(/[\s-]+/g, '_');

  if (ALLOWED_KINDS.includes(up as ReportKindHint)) return up as ReportKindHint;

  // 模型可能写中文或别名，做一次兜底映射
  if (/化验|检验|生化|血常规|尿常规/.test(k)) return 'LAB';
  if (/X\s*线|X光|胸片|DR/i.test(k)) return 'XRAY';
  if (/CT/i.test(k)) return 'CT';
  if (/磁共振|MRI/i.test(k)) return 'MRI';
  if (/超声|彩超|B超/.test(k)) return 'ULTRASOUND';
  if (/心电图|ECG/i.test(k)) return 'ECG';
  if (/内镜|胃镜|肠镜/.test(k)) return 'ENDOSCOPY';
  if (/病理/.test(k)) return 'PATHOLOGY';
  return 'OTHER';
}

/** 取一个非空字符串字段，清洗首尾空白 */
export function strField(raw: unknown, key: string, maxLen = 2000): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = (raw as Record<string, unknown>)[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > maxLen ? t.slice(0, maxLen) : t;
}

/**
 * 把结构化结果拼成规范文本。
 *
 * <p><b>顺序很重要</b>：必须是 名称 → 所见 → 结论。
 * 下游的 reports.ts 用「所见…后接结论标记」的方式切段，
 * 如果把结论放到所见前面，切分就会错位。
 *
 * <p>标题统一用「检查所见」「检查结论」—— 各家报告原文标题五花八门
 * （X线所见 / 影像表现 / 超声提示 / 内镜诊断），这里归一化，
 * 下游只需认一种写法。
 */
export function buildOcrText(r: {
  title: string | null;
  findings: string | null;
  conclusion: string | null;
  items: LabItem[];
  params: ParamItem[];
}): string {
  const lines: string[] = [];

  if (r.title) lines.push(`检查名称：${r.title}`);

  if (r.findings) {
    lines.push(`检查所见：${r.findings.replace(/\s+/g, ' ').trim()}`);
  }

  // 化验单：把数值逐行铺开，这是下游指标抽取要读的内容
  for (const it of r.items) {
    const ref = it.reference ? `（参考范围 ${it.reference}）` : '';
    lines.push(`${it.name} ${it.value}${ref}`.trim());
  }

  // 参数：一行放完，避免被误当作「所见」段落的一部分。
  //
  // 但要**去掉已在所见里出现过的**：心电图的「心电图特征」段本来
  // 就把心率、PR、QRS 都写了一遍，再单独列一次会让文本里同一组数字
  // 出现两遍 —— 界面上看着像两组不同参数。
  if (r.params.length > 0) {
    const findingsFlat = (r.findings ?? '').replace(/\s+/g, '');
    const extra = r.params.filter((p) => {
      const v = p.value.replace(/\s+/g, '');
      return !findingsFlat.includes(v);
    });
    if (extra.length > 0) {
      lines.push(extra.map((p) => `${p.name} ${p.value}`).join('  '));
    }
  }

  if (r.conclusion) {
    lines.push(`检查结论：${r.conclusion.replace(/\s+/g, ' ').trim()}`);
  }

  return lines.join('\n');
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
export async function recognizeReportImage(input: RecognizeInput): Promise<RecognizeResult> {
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
   *
   * 为什么要先分类型：化验单是数值型，影像/心电是结论型。
   * 用同一套「抽出项目与数值」的要求去处理 X 线报告，
   * 只能得到一堆散落的短语，真正的「诊断」那句话反而丢了。
   */
  const prompt = [
    '这是一张医疗检查报告的照片。请只做文字转录，不要解读、不要给建议、不要下结论。',
    '',
    '第一步：判断报告类型 kind，取值只能是：',
    '  LAB 化验单（有项目名+数值+参考范围）',
    '  XRAY X线/DR/胸片   CT   MRI 磁共振',
    '  ULTRASOUND 超声/彩超/B超',
    '  ECG 心电图',
    '  ENDOSCOPY 内镜/胃镜/肠镜',
    '  PATHOLOGY 病理',
    '  OTHER 其他或无法判断',
    '',
    '第二步：输出 JSON，字段含义如下：',
    '{',
    '  "kind": "上面九种之一",',
    '  "title": "检查名称，如「胸部CT平扫」",',
    '  "findings": "「所见/表现/描述/特征」段落的原文（化验单留空）",',
    '  "conclusion": "「结论/诊断/提示/意见」段落的原文",',
    '  "items": [{"name":"项目名","value":"数值+单位","reference":"参考范围"}]，仅化验单填写，其他留空数组,',
    '  "params": [{"name":"心率","value":"72 次/分"}]，心电图/超声的客观参数，没有留空数组',
    '}',
    '',
    '严格要求：',
    '1. 只抄图上真实存在的内容，看不清就留空，**绝不编造**。',
    '2. findings 和 conclusion 要抄完整，不要截断、不要改写措辞。',
    '3. 不要输出任何解释性文字，只输出 JSON。',
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
    // 影像报告的「所见」段落通常较长，800 会被截断 —— 提到 1600
    max_tokens: 1600,
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

  const parsed = extractJson(text);
  const kind = normalizeKind(parsed);
  const title = strField(parsed, 'title', 120);
  const findings = strField(parsed, 'findings', 2000);
  const conclusion = strField(parsed, 'conclusion', 1200);
  const items = normalizeItems(parsed);
  const params = normalizeParams(parsed);

  /*
   * 什么才算「识别成功」？
   *
   * 第一版只认 items 非空，于是 X 线、CT、心电图全部被判定为失败 ——
   * 它们本来就没有「项目 + 数值」这种结构。
   * 正确的判据是：**任意一类内容有实质结果**即可。
   *   · 化验单 → items 有值
   *   · 影像   → findings 或 conclusion 有值
   *   · 心电图 → params 或 conclusion 有值
   */
  const hasContent =
    items.length > 0 ||
    params.length > 0 ||
    Boolean(findings && findings.length >= 4) ||
    Boolean(conclusion && conclusion.length >= 2);

  if (!hasContent) {
    return {
      ok: false,
      reason: 'failed',
      message: '没能从这张图里读出报告内容。请确认图片是检查报告、拍摄清晰，或手动录入。',
    };
  }

  /*
   * rawText 是拼回来的规范文本，用于走后续的 redact() 与入库。
   * 顺序固定为 名称 → 所见 → 数值/参数 → 结论，
   * 这样下游 lib/health/reports.ts 才能正确切分出「所见」与「结论」。
   */
  const rawText = buildOcrText({ title, findings, conclusion, items, params });

  return { ok: true, kind, title, findings, conclusion, items, params, rawText };
}
