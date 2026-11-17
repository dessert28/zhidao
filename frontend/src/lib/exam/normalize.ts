/* ------------------------------------------------------------------
 * 检查项目名称归一 —— 跨院重复检查的前置层
 *
 * ============ 这是什么，不是什么 ============
 *
 * 这是**规则归一**，不是通用 NLP 实体对齐：
 *   · 输入是病历/检查单里的一小段自由文本（"胸部CT平扫""腹部彩超"）
 *   · 输出是有限的「模态:部位」key（"CT:胸部""超声:腹部"）
 *   · 知识来自人工维护的别名表 + 部位表，覆盖常见影像与血液检验
 *
 * 它**不做**这些事：
 *   · 否定/时态理解（"未查胸部CT"仍会命中）—— 病历文本里
 *     "本次未重复开具糖化血红蛋白"这类句子确实会被当成"做过"，
 *     这是有意接受的低成本近似：宁可多提示一次，也不要因为
 *     猜不准否定词而漏掉真正的重复
 *   · 句法分析（"医生建议必要时复查CT"里的 CT 会被归出来）
 *   · 罕见检查（PET-CT、肌电图、内镜……）→ 如实返回 null
 *
 * 为什么宁 null 不猜：归一错一格，上层就会提示"你在两家医院
 * 做过同一项检查"。误报在医患语境里是指控，代价远高于漏报。
 *
 * ============ 为什么 key 是「模态:部位」 ============
 *
 * 重复检查要回答的是"**同一个部位**是不是又被查了一遍"，
 * 模态决定这一遍的信息量。所以：
 *   · 胸部CT 与 胸部计算机断层扫描 → 同一个 key（叫法不同）
 *   · 胸部CT 与 胸部X线 → 不同 key（模态不同，不能互相替代）
 *   · 胸部CT 与 腹部CT → 不同 key（部位不同）
 *
 * 「胸部CT平扫」和「CT胸部平扫」在中文里语序都能出现，
 * 所以不能靠"前缀+正则"，必须把**模态词**和**部位词**分别找出来，
 * 再按「文本距离最近」配对 —— 这就是 normalizeImaging 做的事。
 *
 * ============ 平扫 vs 增强：算同一项 ============
 *
 * 两者在临床上不是一回事（增强要打造影剂、看血供），
 * 但本模块**刻意归到同一个「模态:部位」**，理由：
 *   1. 重复检查提示要回答的是"这个部位短期内又查了一次"，
 *      平扫改增强通常仍要先做平扫定位，辐射与排队成本照样发生
 *   2. 患者手里的两张报告，往往一张写"胸部CT平扫"、
 *      另一张写"胸部CT增强"，如果按字面拆成两项，最典型的
 *      跨院重复场景反而检不出来
 *   3. 提示文案只说"两家医院各做过一次，可以告诉医生"，
 *      不下"这次不用做"的结论 —— 增强与否留给医生判断
 * 所以「平扫/增强/螺旋/薄层/正位/侧位……」都在清洗阶段剔除，
 * 只保留模态 + 部位。这是取舍，不是遗漏。
 * ------------------------------------------------------------------ */

/** 归一后的模态。检验是抽血项目，没有部位。 */
export type ExamModality = 'CT' | 'MRI' | '超声' | 'X线' | '心电图' | '检验';

/** 一条被归一出来的检查 */
export interface NormalizedExam {
  /**
   * 分组用的标准 key：影像为 `模态:部位`（如 `CT:胸部`），
   * 检验为 `检验:名称`（如 `检验:糖化血红蛋白`）。
   */
  standardKey: string;
  /** 展示用标准名，如 `胸部CT`、`腹部超声`、`糖化血红蛋白` */
  name: string;
  /** 命中的片段（已清洗，不含空格与修饰词），用于回溯原文 */
  raw: string;
  modality: ExamModality;
  /** 部位标准名；检验与心电图没有部位，为 null */
  bodyPart: string | null;
}

interface Span {
  start: number;
  end: number;
}

/* ============================ 一、清洗 ============================ */

/**
 * 全角 → 半角。
 *
 * <p>OCR 与手工录入里「ＣＴ」「（平扫）」很常见，
 * 不统一的话同一条记录会分裂成两种写法，归一就白做了。
 */
function toHalfWidth(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/**
 * 修饰词 —— 不影响「模态 + 部位」的判断，统一剔除。
 *
 * <p>`(?:正位|侧位)(?!片)` 的负向前瞻是必要的：
 * 「胸部正位片」里的「正位片」本身就是 X 线的别名，
 * 直接删掉「正位」会剩下一个没有意义的「胸部片」，
 * 反而把这个常见写法弄丢了。
 */
const MODIFIERS = /平扫|增强|螺旋|薄层|轴位|冠状位|三维重建|多期|(?:正位|侧位)(?!片)/g;

/**
 * 括号、引号、冒号等不承载语义的符号。
 *
 * <p>括号里的内容保留（"（无需空腹）"要留给别处判断），只去掉括号本身。
 */
const NOISE_SYMBOLS = /[()[\]{}<>【】《》〈〉「」『』"'`“”‘’·:：_]/g;

/**
 * 清洗：统一字符形态、把换行当分隔符、去掉噪声与修饰词。
 *
 * <p>**换行必须变成分隔符**：检查单是"一行一项"，
 * 若把两行拼成一段，第一行的"胸部"会和第二行的"CT"配成一对，
 * 凭空造出一个没做过的检查。
 */
function prepare(text: string): string {
  return toHalfWidth(text)
    .replace(/[。、]/g, ',')
    .replace(/[\r\n]+/g, ',')
    .replace(/\s+/g, '')
    .replace(NOISE_SYMBOLS, '')
    .replace(MODIFIERS, '');
}

/* ============================ 二、别名表 ============================ */

/** 模态别名。bodyPart 表示别名自身已含部位（"胸片" = 胸部X线）。 */
interface ModalityAlias {
  alias: string;
  modality: Exclude<ExamModality, '检验'>;
  /** 标准名里的模态写法，如 CT / MRI / 超声 / X线 */
  label: string;
  /** 是否必须配一个部位才能成立：心电图单独出现也有意义 */
  needsBodyPart: boolean;
  bodyPart?: string;
}

/**
 * 同一检查的不同叫法。
 *
 * <p>拉丁字母别名（ct / mri / dr / ecg…）在匹配时会额外加字母边界，
 * 否则 "ct" 会命中 "function"、"alt" 会命中 "fast" —— 这类误命中
 * 在上层就是一条凭空的重复检查提示。
 */
const MODALITY_ALIASES: ModalityAlias[] = [
  // —— CT ——
  { alias: '电子计算机断层扫描', modality: 'CT', label: 'CT', needsBodyPart: true },
  { alias: '计算机断层扫描', modality: 'CT', label: 'CT', needsBodyPart: true },
  { alias: '计算机断层', modality: 'CT', label: 'CT', needsBodyPart: true },
  { alias: 'ct', modality: 'CT', label: 'CT', needsBodyPart: true },

  // —— MRI ——
  { alias: '磁共振成像', modality: 'MRI', label: 'MRI', needsBodyPart: true },
  { alias: '核磁共振', modality: 'MRI', label: 'MRI', needsBodyPart: true },
  { alias: '磁共振', modality: 'MRI', label: 'MRI', needsBodyPart: true },
  { alias: '核磁', modality: 'MRI', label: 'MRI', needsBodyPart: true },
  { alias: 'mri', modality: 'MRI', label: 'MRI', needsBodyPart: true },

  // —— 超声 ——
  { alias: '彩色多普勒超声', modality: '超声', label: '超声', needsBodyPart: true },
  { alias: '多普勒超声', modality: '超声', label: '超声', needsBodyPart: true },
  // "超声心动图"是心脏超声的固定叫法，别让「超声」把它拆成无部位的裸模态
  { alias: '超声心动图', modality: '超声', label: '超声', needsBodyPart: true, bodyPart: '心脏' },
  { alias: '彩超', modality: '超声', label: '超声', needsBodyPart: true },
  { alias: 'b超', modality: '超声', label: '超声', needsBodyPart: true },
  { alias: '超声波', modality: '超声', label: '超声', needsBodyPart: true },
  { alias: '超声', modality: '超声', label: '超声', needsBodyPart: true },

  // —— X 线 ——
  { alias: '胸片', modality: 'X线', label: 'X线', needsBodyPart: true, bodyPart: '胸部' },
  { alias: '正位片', modality: 'X线', label: 'X线', needsBodyPart: true },
  { alias: '侧位片', modality: 'X线', label: 'X线', needsBodyPart: true },
  { alias: '平片', modality: 'X线', label: 'X线', needsBodyPart: true },
  { alias: '数字化摄影', modality: 'X线', label: 'X线', needsBodyPart: true },
  { alias: 'x光', modality: 'X线', label: 'X线', needsBodyPart: true },
  { alias: 'x线', modality: 'X线', label: 'X线', needsBodyPart: true },
  { alias: 'dr', modality: 'X线', label: 'X线', needsBodyPart: true },

  // —— 心电图 ——
  { alias: '心电图', modality: '心电图', label: '心电图', needsBodyPart: false },
  { alias: 'ecg', modality: '心电图', label: '心电图', needsBodyPart: false },
  { alias: 'ekg', modality: '心电图', label: '心电图', needsBodyPart: false },
];

interface BodyPartAlias {
  alias: string;
  part: string;
}

/**
 * 部位别名。
 *
 * <p>只收「两字以上、指向明确」的词：单字「肺」「肾」「肝」在
 * "肺炎""肾功能""肝功能"里到处都是，按单字配对会把检验结果
 * 和影像部位搅在一起，进而造出假重复。
 */
const BODY_PART_ALIASES: BodyPartAlias[] = [
  { alias: '肝胆胰脾', part: '腹部' },
  { alias: '肝胆脾胰', part: '腹部' },
  { alias: '上腹部', part: '腹部' },
  { alias: '中上腹', part: '腹部' },
  { alias: '消化系', part: '腹部' },
  { alias: '腹部', part: '腹部' },

  { alias: '胸腔', part: '胸部' },
  { alias: '胸部', part: '胸部' },
  { alias: '双肺', part: '胸部' },
  { alias: '两肺', part: '胸部' },
  { alias: '肺部', part: '胸部' },

  { alias: '颅脑', part: '头颅' },
  { alias: '头颅', part: '头颅' },
  { alias: '脑部', part: '头颅' },
  { alias: '头部', part: '头颅' },

  { alias: '甲状腺', part: '甲状腺' },
  { alias: '颈椎', part: '颈椎' },
  { alias: '腰椎', part: '腰椎' },
  { alias: '子宫附件', part: '盆腔' },
  { alias: '盆腔', part: '盆腔' },
  { alias: '泌尿系', part: '泌尿系' },
  { alias: '双肾', part: '泌尿系' },
  { alias: '肾脏', part: '泌尿系' },
  { alias: '乳腺', part: '乳腺' },
  { alias: '心脏', part: '心脏' },
];

interface LabItem {
  name: string;
  aliases: string[];
}

/** 检验项目别名。key 是 `检验:标准名`，不需要部位。 */
const LAB_ITEMS: LabItem[] = [
  { name: '糖化血红蛋白', aliases: ['糖化血红蛋白', 'hba1c', 'hba1', '糖化'] },
  { name: '空腹血糖', aliases: ['空腹静脉血糖', '空腹血糖', '空腹葡萄糖', 'fbg'] },
  {
    name: '血脂',
    aliases: ['低密度脂蛋白', '高密度脂蛋白', '总胆固醇', '甘油三酯', '血脂', 'ldl', 'hdl'],
  },
  { name: '肝功能', aliases: ['肝功能', '肝功', '转氨酶', 'alt', 'ast'] },
  { name: '肾功能', aliases: ['肾功能', '肾功', '肌酐', '尿素氮', 'egfr'] },
  { name: '甲状腺功能', aliases: ['甲状腺功能', '甲功', 'tsh', 'ft3', 'ft4'] },
];

/* ======================= 三、别名匹配（带位置） ======================= */

const LATIN_ALIAS = /^[a-z0-9]+$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * 在文本里找出某个别名的全部出现位置。
 *
 * <p>拉丁别名的边界用 `[^a-z]` 而不是 `\b`：`\b` 把数字也当单词字符，
 * "HbA1c7.8%" 这种结果紧贴缩写、没有空格的写法会匹配失败 ——
 * 而 "缩写在左、数值紧跟" 恰好是检验单最常见的版式。
 */
function findSpans(haystack: string, alias: string): Span[] {
  const isLatin = LATIN_ALIAS.test(alias);
  const source = isLatin
    ? `(^|[^a-z])${escapeRegExp(alias)}(?![a-z])`
    : escapeRegExp(alias);
  const re = new RegExp(source, 'g');

  const spans: Span[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(haystack)) !== null) {
    const lead = isLatin ? (match[1]?.length ?? 0) : 0;
    const start = match.index + lead;
    spans.push({ start, end: start + alias.length });
  }
  return spans;
}

/** 长别名优先，避免 "超声" 抢先吃掉 "超声心动图"。 */
const SORTED_MODALITY_ALIASES = [...MODALITY_ALIASES].sort(
  (a, b) => b.alias.length - a.alias.length,
);
const SORTED_BODY_PARTS = [...BODY_PART_ALIASES].sort((a, b) => b.alias.length - a.alias.length);

interface ModalityHit extends Span {
  def: ModalityAlias;
}

interface BodyPartHit extends Span {
  part: string;
}

function collectModalities(lower: string): ModalityHit[] {
  const hits: ModalityHit[] = [];
  for (const def of SORTED_MODALITY_ALIASES) {
    for (const span of findSpans(lower, def.alias)) {
      if (hits.some((hit) => overlaps(hit, span))) continue;
      hits.push({ ...span, def });
    }
  }
  // 按出现顺序配对，保证输出顺序与原文一致，便于人工核对
  return hits.sort((a, b) => a.start - b.start);
}

function collectBodyParts(lower: string): BodyPartHit[] {
  const hits: BodyPartHit[] = [];
  for (const def of SORTED_BODY_PARTS) {
    for (const span of findSpans(lower, def.alias)) {
      if (hits.some((hit) => overlaps(hit, span))) continue;
      hits.push({ ...span, part: def.part });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

/* ======================= 四、模态 + 部位配对 ======================= */

/**
 * 部位词与模态词允许隔多远。
 *
 * <p>不设上限的话，"胸部术后改变，建议CT"这种句子会把胸部配给 CT；
 * 设得太小又会漏掉"胸部平扫 CT"（中间夹了修饰词，清洗后已无距离）。
 * 8 个字符能覆盖常见插入语，又挡得住跨分句的错配。
 */
const MAX_PART_DISTANCE = 8;

function spanDistance(a: Span, b: Span): number {
  if (overlaps(a, b)) return 0;
  return a.end <= b.start ? b.start - a.end : a.start - b.end;
}

function makeImagingExam(
  def: ModalityAlias,
  part: string | null,
  clause: string,
  span: Span,
): NormalizedExam {
  const name = def.modality === '心电图' ? '心电图' : `${part ?? ''}${def.label}`;
  return {
    standardKey: `${def.modality}:${part ?? '常规'}`,
    name,
    raw: clause.slice(span.start, span.end),
    modality: def.modality,
    bodyPart: part,
  };
}

/**
 * 从一个分句里抽出影像检查。
 *
 * <p>为什么是"配对"而不是"前缀正则"：中文里「胸部CT」和「CT胸部」
 * 都能写，靠固定语序的正则必然二选一。这里分别找出模态词与部位词，
 * 每个模态取**距离最近的未占用部位** —— "胸部CT、腹部彩超"这种
 * 没有标点分隔的连写也能各归各的。
 */
function normalizeImaging(clause: string, lower: string): NormalizedExam[] {
  const modalities = collectModalities(lower);
  if (modalities.length === 0) return [];

  const parts = collectBodyParts(lower);
  const usedParts = new Set<number>();
  const out: NormalizedExam[] = [];

  for (const hit of modalities) {
    // 别名自带部位（胸片 / 超声心动图），直接成立
    if (hit.def.bodyPart) {
      out.push(makeImagingExam(hit.def, hit.def.bodyPart, clause, hit));
      continue;
    }

    // 心电图不需要部位
    if (!hit.def.needsBodyPart) {
      out.push(makeImagingExam(hit.def, null, clause, hit));
      continue;
    }

    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < parts.length; i++) {
      if (usedParts.has(i)) continue;
      const candidate = parts[i];
      if (!candidate) continue;
      const distance = spanDistance(hit, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    // 找不到部位就放弃：宁可认不出，也不要编一个「胸部CT」
    if (bestIndex < 0 || bestDistance > MAX_PART_DISTANCE) continue;

    usedParts.add(bestIndex);
    const part = parts[bestIndex];
    if (!part) continue;
    out.push(
      makeImagingExam(hit.def, part.part, clause, {
        start: Math.min(hit.start, part.start),
        end: Math.max(hit.end, part.end),
      }),
    );
  }

  return out;
}

/**
 * 从一个分句里抽出检验项目。
 *
 * <p>检验没有部位概念，因此整段扫描即可。取每个项目**最长**的命中别名：
 * "糖化血红蛋白" 比 "糖化" 更具体，raw 也更有说服力。
 */
function normalizeLabs(clause: string, lower: string): NormalizedExam[] {
  const out: NormalizedExam[] = [];

  for (const lab of LAB_ITEMS) {
    const longestFirst = [...lab.aliases].sort((a, b) => b.length - a.length);
    for (const alias of longestFirst) {
      const span = findSpans(lower, alias)[0];
      if (!span) continue;
      out.push({
        standardKey: `检验:${lab.name}`,
        name: lab.name,
        raw: clause.slice(span.start, span.end),
        modality: '检验',
        bodyPart: null,
      });
      break;
    }
  }

  return out;
}

/* ============================ 公共 API ============================ */

/** 分句：逗号、分号、斜杠都视为"另一项"的边界 */
const CLAUSE_SEPARATOR = /[,;/]+/;

/**
 * 从一段自由文本里抽出所有可归一的检查。
 *
 * <p>按分句处理而不是整段扫描，原因同上：跨行/跨项配对会造出
 * 不存在的检查。同一分句内同 key 只保留第一次出现。
 *
 * @returns 识别到的检查；一个都识别不出时返回空数组
 */
export function normalizeRecordExams(text: string): NormalizedExam[] {
  const prepared = prepare(text);
  if (!prepared) return [];

  const seen = new Set<string>();
  const out: NormalizedExam[] = [];

  const push = (exam: NormalizedExam) => {
    if (seen.has(exam.standardKey)) return;
    seen.add(exam.standardKey);
    out.push(exam);
  };

  for (const clause of prepared.split(CLAUSE_SEPARATOR)) {
    if (!clause) continue;
    /*
     * 小写化只用于匹配：中文不受影响，ASCII 的 toLowerCase 是
     * 一字对一字，因此匹配位置可以直接拿去切原文，raw 保留原大小写。
     */
    const lower = clause.toLowerCase();
    for (const exam of normalizeImaging(clause, lower)) push(exam);
    for (const exam of normalizeLabs(clause, lower)) push(exam);
  }

  return out;
}

/**
 * 把单个检查名归一成标准 key（如 `CT:胸部`）。
 *
 * <p>只返回第一个可识别项；文本里可能有多项时请用
 * {@link normalizeRecordExams}。识别不出返回 `null` —— 不猜。
 */
export function normalizeExamName(raw: string): string | null {
  const first = normalizeRecordExams(raw)[0];
  return first?.standardKey ?? null;
}
