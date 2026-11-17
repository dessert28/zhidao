/* ------------------------------------------------------------------
 * 跨院重复检查检测
 *
 * ============ 设计取舍 ============
 *
 * 有两种做法：
 *
 *   A. 给 medical_record 加 exam_items 结构化列，上传时抽取写库
 *   B. 保留自由文本，检测时从 ocr_text 里匹配检查项目词典
 *
 * 选 B。理由：
 *   · 检查项目名称相对标准化（"糖化血红蛋白"最常见的另一种写法就是 HbA1c），
 *     靠词典 + 别名归一的召回率够用，且**零迁移成本**
 *   · 方案 A 要改表、改上传链路、写抽取器 —— 而抽取器本身
 *     也要用同一份词典，等于多绕一圈
 *   · README 原文就是"患者上传后本地归一，dedupe_key 天然就是检测引擎"
 *
 * 这个选择的代价要说清楚：**词典覆盖不到的检查项目检测不出来**。
 * 所以词典里放的是"高频 + 有临床时效性"的那一批，
 * 而不是求全 —— 覆盖不到的漏检，比给出一堆误报更可接受。
 *
 * ============ 为什么还要一层 normalize ============
 *
 * 第一版直接拿 `/胸部.{0,2}超声/` 这类正则扫 ocr_text，问题是
 * 语序一变就漏：「胸部CT平扫」和「CT胸部平扫」是同一件事，
 * 正则却只能覆盖其中一种写法。
 *
 * 现在分两层：
 *   1. `normalize.ts` 负责**认得出**：把自由文本归一成
 *      「模态:部位」key（CT:胸部），语序、别名、全角半角都在那里处理
 *   2. 本文件负责**该不该提示**：词条携带时效窗口与解释文案，
 *      按标准条目分组，再判跨院与间隔
 *
 * 这样归一逻辑只有一个地方，词典只需要声明「我覆盖哪个 key、
 * 窗口多久、为什么」—— 两边不会各写一套正则慢慢漂移。
 *
 * 归一模块没覆盖的写法仍回退到 pattern，
 * 老词典的召回不会因为引入归一变差。
 *
 * ============ 什么才算「重复」 ============
 *
 * 不是"做过两次"，而是"**在时效窗口内做过两次**"。
 * 糖化血红蛋白反映出近 8-12 周平均血糖，3 个月内重查没有额外信息量；
 * 但隔了一年再查是合理的。所以每个项目带自己的窗口。
 *
 * 另一个关键条件：**必须跨院**。同一家医院同一项目做两次，
 * 是医生有意安排的（比如监测趋势），提示"重复"会显得系统不懂临床。
 * ------------------------------------------------------------------ */

import { normalizeRecordExams } from './normalize';

/** 检查项目定义 */
export interface ExamItem {
  /** 标准化名称，用作文案展示（也是 DuplicateFinding.item 的取值） */
  name: string;
  /**
   * 归属的站别：抽血 → LAB，影像 → EXAM。
   *
   * <p>显式标注而不是让调用方按 name 猜：`order-parse` 原来用
   * `/超声|B超/.test(name)` 推断，CT 的名字里没有「超声」，
   * 一加进词典就会被分到抽血站。
   */
  placeType: 'LAB' | 'EXAM';
  /**
   * 归一后的标准 key（与 `normalize.ts` 的 standardKey 对齐）。
   *
   * <p>同一 key 视为同一项检查 —— "胸部CT平扫"与"CT胸部平扫"
   * 都归到 `CT:胸部`，因而必然落进同一组。
   */
  standardKeys: readonly string[];
  /**
   * 兜底匹配用的正则。只在归一没认出时使用，
   * 覆盖归一模块没想到的写法（保持老的召回）。
   */
  pattern: RegExp;
  /**
   * 时效窗口（天）。在这个窗口内重复做，才值得提示。
   * 取值参考临床常规复查间隔（见 docs/09 与提醒引擎的 LAB_RULES）。
   */
  windowDays: number;
  /** 为什么这个间隔有意义 —— 给用户的解释，不是内部注释 */
  rationale: string;
}

/**
 * 检查项目词典。
 *
 * <p>只收录「有明确时效窗口」且「患者常被重复安排」的项目。
 * 平扫/增强在归一阶段已经合并成同一「模态:部位」，这里不必再区分 ——
 * 见 normalize.ts 文件头的取舍说明。胃肠镜这类检查不在此列：
 * 它们的重复通常有明确医学理由，提示反而制造焦虑。
 *
 * <p>注意：词典是**提示范围**的唯一来源。`normalize.ts` 能认出
 * 头颅MRI、腹部CT 等更多 key，但只有在这里声明了窗口与解释，
 * 才会真正产出提示 —— 没有依据的时效窗口不如不提示。
 */
export const EXAM_ITEMS: ExamItem[] = [
  {
    name: '糖化血红蛋白',
    placeType: 'LAB',
    standardKeys: ['检验:糖化血红蛋白'],
    pattern: /(糖化血红蛋白|HbA1c|HbA1C)/i,
    windowDays: 90,
    rationale: '糖化血红蛋白反映近 3 个月平均血糖，3 个月内重查没有额外信息量',
  },
  {
    name: '空腹血糖',
    placeType: 'LAB',
    standardKeys: ['检验:空腹血糖'],
    pattern: /(空腹血糖|空腹静脉血糖)/,
    windowDays: 30,
    rationale: '空腹血糖短期内变化有限，一个月内重复抽血通常不改变用药判断',
  },
  {
    name: '血脂',
    placeType: 'LAB',
    standardKeys: ['检验:血脂'],
    pattern: /(血脂|总胆固醇|甘油三酯|低密度脂蛋白|LDL)/,
    windowDays: 90,
    rationale: '血脂变化缓慢，指南建议 3-6 个月复查一次',
  },
  {
    name: '肝功能',
    placeType: 'LAB',
    standardKeys: ['检验:肝功能'],
    pattern: /(肝功能|转氨酶|ALT|AST)/i,
    windowDays: 90,
    rationale: '肝功能短期波动常见，3 个月内重复检查对判断趋势帮助有限',
  },
  {
    name: '肾功能',
    placeType: 'LAB',
    standardKeys: ['检验:肾功能'],
    pattern: /(肾功能|肌酐|尿素氮|eGFR)/i,
    windowDays: 90,
    rationale: '肾功能 3 个月内重查通常不改变处理方案',
  },
  {
    name: '甲状腺功能',
    placeType: 'LAB',
    standardKeys: ['检验:甲状腺功能'],
    pattern: /(甲状腺功能|甲功|TSH|FT3|FT4)/i,
    windowDays: 90,
    rationale: '甲状腺激素调整后约 6-8 周才稳定，3 个月内重查意义有限',
  },
  {
    name: '腹部超声',
    placeType: 'EXAM',
    standardKeys: ['超声:腹部'],
    pattern:
      /((腹部|上腹|肝胆胰脾|肝胰脾|消化系).{0,4}(超声|B超|彩超)|(超声|B超|彩超).{0,4}(腹部|上腹|肝胆胰脾|肝胰脾|消化系))/,
    windowDays: 180,
    rationale: '无症状者腹部超声半年内重复检查的阳性发现率很低',
  },
  {
    name: '甲状腺超声',
    placeType: 'EXAM',
    standardKeys: ['超声:甲状腺'],
    pattern: /(甲状腺.{0,4}(超声|B超|彩超)|(超声|B超|彩超).{0,4}甲状腺)/,
    windowDays: 180,
    rationale: '甲状腺结节半年内复查通常看不出变化，短期内重复做对判断帮助有限',
  },
  {
    name: '泌尿系超声',
    placeType: 'EXAM',
    standardKeys: ['超声:泌尿系'],
    pattern: /((泌尿系|双肾|肾脏).{0,4}(超声|B超|彩超)|(超声|B超|彩超).{0,4}(泌尿系|双肾|肾脏))/,
    windowDays: 180,
    rationale: '泌尿系超声半年内重复检查的阳性发现率较低',
  },
  {
    name: '胸部CT',
    placeType: 'EXAM',
    standardKeys: ['CT:胸部'],
    pattern: /(胸部.{0,4}(CT|计算机断层|断层扫描)|(CT|计算机断层|断层扫描).{0,4}胸部)/i,
    windowDays: 180,
    rationale: '胸部CT有辐射、花费也不低，半年内没有新症状时重复做，对判断帮助有限',
  },
  {
    name: '头颅CT',
    placeType: 'EXAM',
    standardKeys: ['CT:头颅'],
    pattern:
      /((头颅|颅脑|脑部|头部).{0,4}(CT|计算机断层|断层扫描)|(CT|计算机断层|断层扫描).{0,4}(头颅|颅脑|脑部|头部))/i,
    windowDays: 180,
    rationale: '头颅CT短期内重复做，除非症状有明显变化，否则对判断帮助有限',
  },
  {
    name: '头颅MRI',
    placeType: 'EXAM',
    standardKeys: ['MRI:头颅'],
    pattern:
      /((头颅|颅脑|脑部|头部).{0,4}(MRI|磁共振|核磁)|(MRI|磁共振|核磁).{0,4}(头颅|颅脑|脑部|头部))/i,
    windowDays: 180,
    rationale: '头颅MRI排队久、费用高，半年内重复做对判断帮助有限',
  },
  {
    name: '胸部X线',
    placeType: 'EXAM',
    standardKeys: ['X线:胸部'],
    pattern:
      /(胸片|胸部.{0,4}(X线|X光|DR|平片|正位片|侧位片)|(X线|X光|DR|平片).{0,4}胸部)/i,
    windowDays: 180,
    rationale: '胸片变化较慢，半年内重复拍片对判断帮助有限',
  },
  {
    name: '心电图',
    placeType: 'EXAM',
    standardKeys: ['心电图:常规'],
    pattern: /(心电图|ECG|EKG)/i,
    windowDays: 30,
    rationale: '心电图反映检查当时的心电活动，短期内没有新症状时重复检查信息量有限',
  },
];

/* ============================ 检测 ============================ */

/** 一条就诊记录（只用检测需要的字段） */
export interface RecordLike {
  id: number;
  hospitalCode: string;
  visitDate: string;
  department?: string | null;
  /** 脱敏后的病历文本；检查项目从这里匹配 */
  ocrText?: string | null;
  diagnosisBrief?: string | null;
}

/** 一次命中的检查 */
interface ExamOccurrence {
  item: ExamItem;
  hospitalCode: string;
  visitDate: string;
  recordId: number;
}

export interface DuplicateFinding {
  /** 检查项目名 */
  item: string;
  /** 两次检查的院区与日期，按时间升序 */
  occurrences: Array<{ hospitalCode: string; visitDate: string; recordId: number }>;
  /** 两次相隔多少天 */
  gapDays: number;
  /** 为什么要提示（给用户看的解释） */
  rationale: string;
  /** 给界面的一句话结论 */
  message: string;
}

/** standardKey → 词典条目。模块加载时建一次，避免每条记录重复扫词典。 */
const ITEM_BY_STANDARD_KEY: ReadonlyMap<string, ExamItem> = (() => {
  const map = new Map<string, ExamItem>();
  for (const item of EXAM_ITEMS) {
    for (const key of item.standardKeys) map.set(key, item);
  }
  return map;
})();

/**
 * 从记录里抽取所有体检项目出现记录。
 *
 * <p>一条记录里出现多个项目就产生多条 —— 一次生化全套里
 * 可能同时有血糖、血脂、肝功能，各自独立计时效窗口。
 *
 * <p>两层识别，且同一项目在一份记录里只计一次：
 * <ol>
 *   <li>先归一：「胸部CT平扫」和「CT胸部平扫」都得到 `CT:胸部`</li>
 *   <li>归一没覆盖的写法回退 pattern，保证老的召不回退</li>
 * </ol>
 * 两层都命中的话以归一为准（标准名已经统一，文案更一致）。
 */
function extractOccurrences(records: readonly RecordLike[]): ExamOccurrence[] {
  const out: ExamOccurrence[] = [];

  for (const r of records) {
    const text = `${r.ocrText ?? ''} ${r.diagnosisBrief ?? ''}`;
    if (!text.trim()) continue;

    /** 本记录已经计过的项目，防止归一与兜底各记一次 */
    const matched = new Set<string>();

    const push = (item: ExamItem) => {
      if (matched.has(item.name)) return;
      matched.add(item.name);
      out.push({
        item,
        hospitalCode: r.hospitalCode,
        visitDate: r.visitDate,
        recordId: r.id,
      });
    };

    for (const exam of normalizeRecordExams(text)) {
      // 归一得出的是「检查本身」；能不能提示取决于词典有没有
      // 为它声明窗口与解释。没声明就跳过，不硬套别人的窗口。
      const item = ITEM_BY_STANDARD_KEY.get(exam.standardKey);
      if (item) push(item);
    }

    for (const item of EXAM_ITEMS) {
      if (matched.has(item.name)) continue;
      // pattern 都不带 g，test 无状态，可以直接复用
      if (item.pattern.test(text)) push(item);
    }
  }

  return out;
}

function daysBetween(a: string, b: string): number {
  const t1 = new Date(a).getTime();
  const t2 = new Date(b).getTime();
  if (Number.isNaN(t1) || Number.isNaN(t2)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(t2 - t1) / 86_400_000);
}

/**
 * 检测跨院重复检查。
 *
 * <p>判定三个条件必须同时满足：
 * <ol>
 *   <li>同一个检查项目出现 ≥2 次</li>
 *   <li>**来自不同院区**（同院重复是医生有意安排）</li>
 *   <li>任意两次的间隔落在该项目的时效窗口内</li>
 * </ol>
 *
 * @returns 按"间隔最短"排序的发现，最值得提示的排前面
 */
export function detectDuplicateExams(records: readonly RecordLike[]): DuplicateFinding[] {
  const occurrences = extractOccurrences(records);
  const findings: DuplicateFinding[] = [];

  /*
   * 按检查项目分组。
   *
   * 分组键用 name 而不是原始文本：归一已经把「胸部CT平扫」
   * 「CT胸部平扫」「胸部计算机断层扫描」折叠到同一条目，
   * 这里才可以只看条目本身。name 与 standardKey 一一对应
   * （一个条目不会声明两个互不相干的 key），所以不必再维护
   * 第二层 key → 条目映射。
   */
  const byItem = new Map<string, ExamOccurrence[]>();
  for (const o of occurrences) {
    const list = byItem.get(o.item.name) ?? [];
    list.push(o);
    byItem.set(o.item.name, list);
  }

  for (const [name, list] of byItem) {
    if (list.length < 2) continue;

    // 按时间升序，找最接近的一对「跨院」记录
    const sorted = [...list].sort((a, b) => a.visitDate.localeCompare(b.visitDate));

    let best: { gap: number; a: ExamOccurrence; b: ExamOccurrence } | null = null;

    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;

        // 必须跨院
        if (a.hospitalCode === b.hospitalCode) continue;

        const gap = daysBetween(a.visitDate, b.visitDate);
        if (gap > a.item.windowDays) continue;

        if (!best || gap < best.gap) best = { gap, a, b };
      }
    }

    if (!best) continue;

    const item = best.a.item;
    const gapText = best.gap === 0 ? '同一天' : `${best.gap} 天`;
    findings.push({
      item: name,
      occurrences: [
        { hospitalCode: best.a.hospitalCode, visitDate: best.a.visitDate, recordId: best.a.recordId },
        { hospitalCode: best.b.hospitalCode, visitDate: best.b.visitDate, recordId: best.b.recordId },
      ],
      gapDays: best.gap,
      rationale: item.rationale,
      /*
       * 措辞原则：**陈述事实 + 建议询问，不下结论**。
       *
       * 不说"你被重复检查了"（那是指控医院），
       * 也不说"这次不用查了"（那是医学判断）。
       * 说"两次相隔 N 天，你可以告诉医生已经做过"——
       * 把决定权交回患者和医生。
       */
      message: `${name}在两家医院各做过一次，相隔 ${gapText}。就诊时可以告诉医生已经做过，避免重复。`,
    });
  }

  return findings.sort((a, b) => a.gapDays - b.gapDays);
}

/** 供测试与调试：列出词典覆盖的项目名 */
export const EXAM_ITEM_NAMES = EXAM_ITEMS.map((e) => e.name);
