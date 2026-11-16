/* ------------------------------------------------------------------
 * 检查报告解析 —— 除了化验单，还有 X 线 / CT / 彩超 / 心电图 / 内镜
 *
 * ============ 为什么不能一套规则处理所有检查 ============
 *
 * 化验单是**数值型**：一堆数字 + 参考范围，患者看不懂的是「这个数高不高」。
 * 影像和心电图是**结论型**：一堆描述性文字 + 一句诊断，
 * 患者看不懂的是「这个结论到底要不要紧」。
 *
 * 两类报告的阅读方式完全不同，所以要先分类，再分别抽取。
 *
 * ============ 一条必须守住的边界 ============
 *
 * 我们只做**信息整理**：把「所见」和「诊断」从报告原文里分出来，
 * 标出结论里是否出现需要随访的字样。**不解释影像结果的含义** ——
 * 「磨玻璃结节 4mm 意味着什么」必须由医生判断，我们说了就是越界。
 * ------------------------------------------------------------------ */

/** 检查报告类型 */
export type ReportKind =
  | 'LAB'
  | 'XRAY'
  | 'CT'
  | 'MRI'
  | 'ULTRASOUND'
  | 'ECG'
  | 'ENDOSCOPY'
  | 'PATHOLOGY'
  | 'OTHER';

/** 类型的中文名与视觉标识 */
export const KIND_META: Record<ReportKind, { label: string; short: string }> = {
  LAB: { label: '化验', short: '化验' },
  XRAY: { label: 'X 线', short: 'X线' },
  CT: { label: 'CT', short: 'CT' },
  MRI: { label: '磁共振', short: 'MRI' },
  ULTRASOUND: { label: '超声 / 彩超', short: '超声' },
  ECG: { label: '心电图', short: '心电' },
  ENDOSCOPY: { label: '内镜', short: '内镜' },
  PATHOLOGY: { label: '病理', short: '病理' },
  OTHER: { label: '其他', short: '其他' },
};

/** 解析结果 */
export interface ParsedReport {
  kind: ReportKind;
  /** 「检查所见」原文。抽不到为 null */
  findings: string | null;
  /** 「检查结论 / 诊断 / 提示」原文。抽不到为 null */
  conclusion: string | null;
  /**
   * 结论是否出现需要随访/复查的字样。
   *
   * <p>这不是诊断判断，只是**文本标记** —— 报告原文里写了「建议复查」
   * 「结节」「增厚」这类词，说明医生认为需要跟进。
   * 我们只负责不让人漏看，不负责解释它意味着什么。
   */
  needsFollowUp: boolean;
  /** 结构化参数（心电图 / 超声测量值等） */
  params: Array<{ name: string; value: string }>;
  /** 检查部位，如「胸部」「腹部」「颈动脉」。抽不到为 null */
  bodyPart: string | null;
}

/**
 * 类型识别。按**特异性从高到低**匹配 ——
 * 「心脏彩超」既是超声也可能被 X 线规则误吃，所以先判超声再判 X 线。
 */
const KIND_PATTERNS: Array<{ kind: ReportKind; re: RegExp }> = [
  { kind: 'ECG', re: /心电图|ECG|心电圖|窦性心律|QRS/ },
  { kind: 'ENDOSCOPY', re: /内镜|胃镜|肠镜|支气管镜|喉镜|贲门|胃窦|十二指肠球部/ },
  { kind: 'PATHOLOGY', re: /病理(诊断|检查|报告)|石蜡|免疫组化|镜下见.*细胞/ },
  { kind: 'MRI', re: /磁共振|MRI|MR[I]?\s*(平扫|增强)/i },
  { kind: 'CT', re: /CT\s*(平扫|增强|检查|报告)?|螺旋CT|CT值/i },
  { kind: 'ULTRASOUND', re: /超声|彩超|B超|多普勒|彩色多普勒/ },
  { kind: 'XRAY', re: /X\s*线|X光|DR|胸片|摄片|正位片|侧位片|放射科/i },
  { kind: 'LAB', re: /化验|检验|生化|血常规|尿常规|参考范围|mmol\/L|g\/L/ },
];

/** 识别报告类型。识别不出时返回 OTHER，而不是猜一个 */
export function detectKind(text: string, fileName?: string | null): ReportKind {
  const hay = `${fileName ?? ''}\n${text ?? ''}`;
  if (!hay.trim()) return 'OTHER';
  for (const { kind, re } of KIND_PATTERNS) {
    if (re.test(hay)) return kind;
  }
  return 'OTHER';
}

/**
 * 「所见」段落。
 *
 * <p>写成 (?:检查)?(?:所见|表现|描述) 是因为各家报告的标题不统一：
 * 「X线所见」「检查所见」「影像表现」「超声描述」都有。
 */
const FINDINGS_RE =
  /(?:检查|影像|X线|超声|内镜|CT|MRI|磁共振)?\s*(?:所见|表现|描述|特征)\s*[:：]\s*([\s\S]*?)(?=(?:检查|影像|X线|超声|内镜|CT|MRI|磁共振)?\s*(?:结论|诊断|提示|意见|印象)\s*[:：]|$)/;

/** 「结论」段落 */
const CONCLUSION_RE =
  /(?:检查|影像|X线|超声|内镜|CT|MRI|磁共振)?\s*(?:结论|诊断|提示|意见|印象)\s*[:：]\s*([\s\S]*)$/;

/**
 * 需要随访的信号词。
 *
 * <p><b>先判「正常表述」再判异常词</b>：因为「未见明显异常」里含「异常」，
 * 直接匹配异常词会把一切正常报告都标成需要关注 —— 那等于制造焦虑。
 */
const NORMAL_PHRASES =
  /未见明显异常|未见异常|未见明显病变|未见明显实质性病变|大致正常|在正常范围|未见明显狭窄|阴性|无异常/;

const FOLLOW_UP_WORDS =
  /结节|增厚|斑块|糜烂|肿大|积液|狭窄|钙化|占位|息肉|溃疡|囊肿|结石|异常|建议.{0,6}(复查|随访|进一步)|请.{0,4}(复查|随访)/;

/** 判断结论是否需要跟进 */
export function needsFollowUp(conclusion: string | null): boolean {
  if (!conclusion) return false;
  if (NORMAL_PHRASES.test(conclusion)) return false;
  return FOLLOW_UP_WORDS.test(conclusion);
}

/** 心电图常见参数。抽到就展示 —— 它们是客观数值，不含解释 */
const ECG_PARAMS: Array<{ name: string; re: RegExp }> = [
  { name: '心率', re: /心率\s*[:：]?\s*(\d{2,3})\s*次\s*\/?\s*分/ },
  { name: 'PR 间期', re: /PR\s*间期\s*[:：]?\s*(\d{2,3})\s*ms/i },
  { name: 'QRS 时限', re: /QRS\s*(?:时限|时间|宽度)\s*[:：]?\s*(\d{2,3})\s*ms/i },
  { name: 'QT/QTc', re: /QT\s*\/?\s*QTc\s*[:：]?\s*(\d{2,3}\s*\/\s*\d{2,3})\s*ms/i },
];

/** 超声/CT 的测量值：「直径约 4mm」「厚约 1.1mm」「大小约 3.2×1.8mm」 */
const MEASURE_RE =
  /([\u4e00-\u9fa5A-Za-z]{2,8})?约?\s*(\d+(?:\.\d+)?(?:\s*[×xX]\s*\d+(?:\.\d+)?)?)\s*(mm|cm|毫升|ml)/gi;


/** 检查部位 */
const BODY_PART_RE =
  /(胸部|腹部|头颅|颅脑|颈部|颈动脉|心脏|肝胆|胆囊|胰腺|脾脏|双肾|泌尿系|盆腔|乳腺|甲状腺|膝关节|腰椎|颈椎|全身)/;

/** 解析一份检查报告 */
export function parseReport(text: string, fileName?: string | null): ParsedReport {
  const src = (text ?? '').trim();
  const kind = detectKind(src, fileName);

  const findings = FINDINGS_RE.exec(src)?.[1]?.trim() ?? null;
  // 诊断段可能一开始就被「结论：」带出，也可能夹在所见之后
  const conclusion = CONCLUSION_RE.exec(src)?.[1]?.trim() ?? null;

  const params: Array<{ name: string; value: string }> = [];
  if (kind === 'ECG') {
    for (const p of ECG_PARAMS) {
      const m = p.re.exec(src);
      if (m) params.push({ name: p.name, value: `${m[1]}${p.name === '心率' ? ' 次/分' : ' ms'}` });
    }
  }
  if (kind === 'ULTRASOUND' || kind === 'CT') {
    /*
     * 只取最多 3 个带单位的测量值。
     *
     * 必须按**数值去重**：同一处尺寸常在「所见」和「结论」里各写一遍
     * （「磨玻璃结节，直径约 4mm」+「磨玻璃结节（约 4mm）」），
     * 不去重会显示成「直径约 4mm / 测量值 4mm」两条，看着像两个不同指标。
     */
    let m: RegExpExecArray | null;
    const re = new RegExp(MEASURE_RE.source, 'gi');
    const seen = new Set<string>();
    while ((m = re.exec(src)) !== null && params.length < 3) {
      const rawValue = m[2]!.replace(/\s+/g, '');
      if (seen.has(rawValue)) continue;
      seen.add(rawValue);
      // 标签取测量词（直径/厚/大小），没有就用「尺寸」——
      // 「测量值」这种说法对患者没有信息量
      const label = (m[1] ?? '').trim() || '尺寸';
      params.push({ name: label, value: `${rawValue}${m[3]}` });
    }
  }

  return {
    kind,
    findings,
    conclusion,
    needsFollowUp: needsFollowUp(conclusion),
    params,
    bodyPart: BODY_PART_RE.exec(src)?.[1] ?? null,
  };
}

/** 给界面的一句话摘要：优先用结论，没有就用所见开头 */
export function summarizeReport(r: ParsedReport, maxLen = 60): string {
  const base = r.conclusion ?? r.findings ?? '';
  if (!base) return '报告内容未能识别';
  const oneLine = base.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen)}…` : oneLine;
}

/** 是否为「结论型」报告（影像 / 心电 / 内镜），它们看结论而不是数值 */
export function isConclusionType(kind: ReportKind): boolean {
  return kind !== 'LAB' && kind !== 'OTHER';
}
