/* ------------------------------------------------------------------
 * 健康指标抽取与解释 —— 「健康管家」的地基
 *
 * ============ 它解决什么 ============
 *
 * 患者手里有一堆化验单，每张上十几个数字，没人告诉他哪些要紧。
 * 这个模块做三件事：
 *   1. 从病历文本里**抽出结构化指标**（项目名、数值、单位、日期）
 *   2. 判断**是否偏离参考范围**
 *   3. 给出**通俗解释**（高了会怎样、要不要紧、该怎么办）
 *
 * ============ 为什么只做「常见、可量化、有明确参考范围」的指标 ============
 *
 * 化验单上的项目成百上千。全做等于每个都要查权威参考范围，
 * 而参考范围还因实验室、性别、年龄而异。
 * 所以只收 12 个高频且有共识范围的项目 ——
 * **宁可覆盖少，也不能给出错的参考范围**。
 * 覆盖不到的指标，界面显示「已记录，请咨询医生」而不是瞎判断。
 *
 * ============ 参考范围的来源与局限 ============
 *
 * 下面的范围是**成人通用参考值**，来自公开的临床常规标准。
 * 必须说清三条局限：
 *   · 不同实验室的参考范围有差异（同一份血，两家医院可能一个标 3.9-6.1、
 *     一个标 4.0-6.2）
 *   · 妊娠、儿童、老年人不适用
 *   · 有些指标的判断要看趋势而不是单次值
 * 所以界面上永远把它当「参考」而不是「结论」，并给出去找医生的建议。
 * ------------------------------------------------------------------ */

/** 一个指标的定义 */
export interface MarkerDef {
  /** 标准名，如「空腹血糖」 */
  name: string;
  /** 匹配文本用的正则（同义写法都放进来） */
  pattern: RegExp;
  /** 单位 */
  unit: string;
  /** 成人参考下限。null 表示没有下限 */
  low: number | null;
  /** 成人参考上限。null 表示没有上限 */
  high: number | null;
  /**
   * 偏离时的通俗解释。分「偏高」「偏低」两种。
   * 写给不懂医的人看：不出现「病理」「指征」这类词。
   */
  highMeaning: string;
  lowMeaning: string;
  /** 下一步该做什么（一般性建议，不给治疗建议） */
  highAdvice: string;
  lowAdvice: string;
  /** 相关的科室，用于"该挂哪个科" */
  department: string;
}

/**
 * 指标词典。
 *
 * <p><b>每个 pattern 必须带一个数值捕获组</b> —— 这是硬约束。
 * 第一版只匹配了指标名（如 /(空腹血糖|空腹静脉血糖)/），
 * 结果 pickNumber 取到的是名称本身、被判为非数字后全部跳过，
 * 测试当场报「expected [] to include 空腹血糖」。
 *
 * <p>数值组的写法统一是 {@code [^\d]{0,6}(\d+(?:\.\d+)?)}：
 * 名称与数值之间允许 0-6 个非数字字符（空格、冒号、单位前缀等）。
 * 用非贪婪的"非数字"而不是固定空格，是因为不同化验单的排版差异很大：
 * 「空腹血糖 8.4」「空腹血糖:8.4」「空腹血糖值8.4mmol/L」都要能读。
 *
 * <p>顺序有意义：**长名在前**。"糖化血红蛋白"必须排在"血糖"之前匹配，
 * 否则"糖化血红蛋白 7.8%"会被"血糖"规则吃掉。
 */
export const MARKERS: MarkerDef[] = [
  {
    name: '糖化血红蛋白',
    pattern: /(?:糖化血红蛋白|HbA1c|HbA1C)[^\d]{0,8}(\d+(?:\.\d+)?)/i,
    unit: '%',
    low: 4.0,
    high: 6.0,
    highMeaning:
      '这个数反映过去 2-3 个月的平均血糖水平。偏高说明这段时间血糖整体控制得不太好，不是某一天吃多了造成的。',
    lowMeaning: '偏低可能与近期血糖偏低或贫血有关，需要医生判断。',
    highAdvice:
      '通常糖尿病患者的控制目标是 7% 以下，具体目标由医生定。建议带最近几次记录找内分泌科医生看是否需要调整方案。',
    lowAdvice: '建议咨询医生，结合其他检查判断。',
    department: '内分泌科',
  },
  {
    name: '空腹血糖',
    pattern: /(?:空腹血糖|空腹静脉血糖|空腹血糖值)[^\d]{0,8}(\d+(?:\.\d+)?)/,
    unit: 'mmol/L',
    low: 3.9,
    high: 6.1,
    highMeaning:
      '空腹血糖偏高，可能是一次性的（前一天晚饭吃得晚、压力大），也可能是持续偏高。单次偏高不足以说明问题，要看多次记录。',
    lowMeaning: '空腹血糖偏低，如果同时有心慌、出汗、手抖，要注意低血糖。',
    highAdvice:
      '建议在不同日、不同时间段再测几次并记录。如果多次空腹都在 7.0 以上，应到内分泌科就诊。',
    lowAdvice: '留意有没有低血糖症状；反复偏低要找医生看。',
    department: '内分泌科',
  },
  {
    name: '餐后血糖',
    pattern: /(?:餐后2?小时血糖|餐后血糖)[^\d]{0,8}(\d+(?:\.\d+)?)/,
    unit: 'mmol/L',
    low: null,
    high: 7.8,
    highMeaning: '餐后 2 小时血糖偏高，反映进食后血糖上升得比较多。',
    lowMeaning: '餐后血糖偏低不常见，如伴不适请咨询医生。',
    highAdvice: '注意主食的量与种类，建议记录餐后血糖并与医生讨论。',
    lowAdvice: '如伴随不适请咨询医生。',
    department: '内分泌科',
  },
  {
    name: '总胆固醇',
    pattern: /(?:总胆固醇|TC)[^\d]{0,8}(\d+(?:\.\d+)?)/,
    unit: 'mmol/L',
    low: null,
    high: 5.2,
    highMeaning: '总胆固醇偏高，长期偏高会增加心血管风险。',
    lowMeaning: '偏低一般不需要特别处理，结合其他血脂指标看。',
    highAdvice: '建议同时看低密度脂蛋白。饮食上减少动物油脂，必要时由医生评估是否需要用药。',
    lowAdvice: '一般无需处理，如明显偏低请咨询医生。',
    department: '心血管内科',
  },
  {
    name: '低密度脂蛋白',
    pattern: /(?:低密度脂蛋白|LDL-?C?)[^\d]{0,8}(\d+(?:\.\d+)?)/i,
    unit: 'mmol/L',
    low: null,
    high: 3.4,
    highMeaning:
      '这个常被称为「坏胆固醇」，偏高是动脉粥样硬化的主要风险因素之一。',
    lowMeaning: '偏低通常不是问题。',
    highAdvice:
      '有高血压或糖尿病的人，医生往往要求更严格的目标（如 2.6 以下）。建议到心血管内科评估。',
    lowAdvice: '一般无需处理。',
    department: '心血管内科',
  },
  {
    name: '甘油三酯',
    pattern: /(?:甘油三酯|TG)[^\d]{0,8}(\d+(?:\.\d+)?)/,
    unit: 'mmol/L',
    low: null,
    high: 1.7,
    highMeaning: '甘油三酯偏高，与饮食（尤其酒精、甜食、精制碳水）关系较大。',
    lowMeaning: '偏低一般不具临床意义。',
    highAdvice: '复查前需空腹 12 小时。减少酒精与含糖饮料，必要时找医生评估。',
    lowAdvice: '一般无需处理。',
    department: '心血管内科',
  },
  {
    name: '尿酸',
    pattern: /(?:尿酸|UA)[^\d]{0,8}(\d{2,4})/,
    unit: 'μmol/L',
    low: null,
    high: 420,
    highMeaning:
      '尿酸偏高。不一定立刻有症状，但长期偏高会增加痛风与肾结石的风险。',
    lowMeaning: '尿酸偏低少见，一般无需处理。',
    highAdvice: '减少动物内脏、海鲜、啤酒；多喝水。有痛风发作史的建议到风湿免疫科就诊。',
    lowAdvice: '一般无需处理。',
    department: '风湿免疫科',
  },
  {
    name: '肌酐',
    pattern: /(?:肌酐|CREA|Cr)[^\d]{0,8}(\d{2,4})/i,
    unit: 'μmol/L',
    low: null,
    high: 104,
    highMeaning: '肌酐偏高可能提示肾脏排泄功能受影响，需要结合其他检查判断。',
    lowMeaning: '肌酐偏低常与肌肉量少有关，一般不是问题。',
    highAdvice: '建议到肾内科就诊，带上既往所有肾功能检查做对比。',
    lowAdvice: '一般无需特殊处理。',
    department: '肾脏内科',
  },
  {
    name: '转氨酶',
    pattern: /(?:谷丙转氨酶|丙氨酸氨基转移酶|ALT)[^\d]{0,8}(\d{1,4})/i,
    unit: 'U/L',
    low: null,
    high: 40,
    highMeaning:
      '转氨酶偏高可能与饮酒、药物、脂肪肝等有关。轻度升高常见且多为一过性。',
    lowMeaning: '偏低一般无临床意义。',
    highAdvice: '建议 2-4 周后复查一次；复查前 3 天避免饮酒与剧烈运动。持续升高到消化内科就诊。',
    lowAdvice: '一般无需处理。',
    department: '消化内科',
  },
  {
    name: '血红蛋白',
    pattern: /(?:血红蛋白|Hb|HGB)[^\d]{0,8}(\d{2,3})/i,
    unit: 'g/L',
    low: 130,
    high: 175,
    highMeaning: '血红蛋白偏高可能与脱水、吸烟等有关。',
    lowMeaning: '血红蛋白偏低提示可能贫血，常见表现是乏力、脸色白、容易累。',
    highAdvice: '注意补水，戒烟；持续偏高建议进一步检查。',
    lowAdvice: '建议到血液内科或全科查一下贫血原因，不要自行长期补铁。',
    department: '血液内科',
  },
];

/**
 * 血压是**一个数对**，不能用上面的单值规则。
 *
 * <p>"血压 158/96 mmHg" 是最常见的写法，也是最容易被漏掉的：
 * 单值规则只能匹配到 158 或 96 中的一个，另一个丢了。
 * 而血压的两个值临床意义不同（收缩压反映大动脉弹性，
 * 舒张压反映外周阻力），缺一个判断就不完整。
 *
 * <p>所以血压单独用一条规则匹配「X/Y」的形式，两个值都取出来。
 */
const BP_PATTERN = /(?:血压|BP)[^\d]{0,6}(\d{2,3})\s*\/\s*(\d{2,3})/;

/** 单值形式的血压：「收缩压 158」「高压 158」 */
const SYSTOLIC_ALONE = /(?:收缩压|高压)[^\d]{0,6}(\d{2,3})/;
const DIASTOLIC_ALONE = /(?:舒张压|低压)[^\d]{0,6}(\d{2,3})/;

/** 收缩压 / 舒张压的定义，供评估时查 */
const BP_DEFS: Record<string, MarkerDef> = {
  收缩压: {
    name: '收缩压',
    pattern: SYSTOLIC_ALONE,
    unit: 'mmHg',
    low: 90,
    high: 140,
    highMeaning: '收缩压偏高。单次偏高不足以诊断高血压，要看多次不同日的测量。',
    lowMeaning: '收缩压偏低，可能头晕乏力，起身时要慢。',
    highAdvice: '建议连续一周早晚各测一次并记录。若多次达到 140 以上，到心血管内科就诊。',
    lowAdvice: '注意起身缓慢、多喝水；反复偏低要就医。',
    department: '心血管内科',
  },
  舒张压: {
    name: '舒张压',
    pattern: DIASTOLIC_ALONE,
    unit: 'mmHg',
    low: 60,
    high: 90,
    highMeaning: '舒张压偏高，常见于中青年，与压力、作息、体重有关。',
    lowMeaning: '舒张压偏低，通常与收缩压一起看。',
    highAdvice: '同样需要多次测量记录；持续偏高建议就诊心血管内科。',
    lowAdvice: '如伴头晕乏力，建议就医评估。',
    department: '心血管内科',
  },
};

/** 一次抽取到的指标值 */
export interface MarkerReading {
  /** 标准名 */
  name: string;
  /** 数值 */
  value: number;
  /** 单位 */
  unit: string;
  /** 原始文本片段（供患者核对是不是抽错了） */
  source: string;
}

/**
 * 从一段病历文本里抽出所有指标。
 *
 * <p>为什么返回数组而不是 Map：同一次检查里可能同时有收缩压与舒张压，
 * 它们的 name 不同，用 Map 也没问题；但保留数组能让调用方保持文本顺序，
 * 便于展示「这份报告里都有什么」。
 */
export function extractMarkers(text: string): MarkerReading[] {
  if (!text) return [];
  const out: MarkerReading[] = [];

  /*
   * 血压要先单独处理。
   *
   * 「血压 158/96」是两个值，单值规则只能匹配到一个，
   * 另一个会丢。而且如果先跑单值规则，SYSTOLIC_ALONE 的
   * 「收缩压 158」也会匹配到 X/Y 中的 158 —— 不能重复计。
   * 所以血压一次性取出两个值，随后把它从待匹配文本里剔除，
   * 避免单值规则再命中一遍。
   */
  let rest = text;
  const bp = BP_PATTERN.exec(text);
  if (bp) {
    out.push({ name: '收缩压', value: Number(bp[1]), unit: 'mmHg', source: bp[0].trim() });
    out.push({ name: '舒张压', value: Number(bp[2]), unit: 'mmHg', source: bp[0].trim() });
    rest = text.replace(bp[0], ' ');
  } else {
    // 没有 X/Y 形式时，退回单值规则
    const s = SYSTOLIC_ALONE.exec(text);
    if (s) {
      out.push({ name: '收缩压', value: Number(s[1]), unit: 'mmHg', source: s[0].trim() });
      rest = rest.replace(s[0], ' ');
    }
    const d = DIASTOLIC_ALONE.exec(text);
    if (d) {
      out.push({ name: '舒张压', value: Number(d[1]), unit: 'mmHg', source: d[0].trim() });
      rest = rest.replace(d[0], ' ');
    }
  }

  for (const def of MARKERS) {
    /*
     * 用带捕获组的正则找出数值。
     *
     * <p>每个 pattern 的**最后一个捕获组是数值**（见词典注释）。
     * 统一用 pickNumber 从后往前找第一个像数字的组，
     * 这样各指标不用各写一套解析。
     */
    const re = new RegExp(
      def.pattern.source,
      def.pattern.flags.includes('g') ? def.pattern.flags : def.pattern.flags + 'g',
    );

    let m: RegExpExecArray | null;
    while ((m = re.exec(rest)) !== null) {
      const numStr = pickNumber(m);
      if (numStr === null) continue;
      const value = Number(numStr);
      if (!Number.isFinite(value)) continue;

      out.push({
        name: def.name,
        value,
        unit: def.unit,
        source: m[0].trim(),
      });
      // 同一段文本里同名指标只取第一个
      break;
    }
  }

  return out;
}

/** 从匹配结果里取数值 —— 优先取最后一个数字捕获组 */
function pickNumber(m: RegExpExecArray): string | null {
  for (let i = m.length - 1; i >= 1; i--) {
    const g = m[i];
    if (g && /^\d{1,4}(\.\d{1,2})?$/.test(g)) return g;
  }
  return null;
}

/** 一个指标的评估结果 */
export interface MarkerEvaluation {
  name: string;
  value: number;
  unit: string;
  /** normal / high / low */
  level: 'normal' | 'high' | 'low';
  /** 参考范围的文字描述 */
  rangeText: string;
  /** 通俗解释 */
  meaning: string;
  /** 下一步建议 */
  advice: string;
  /** 相关科室 */
  department: string;
}

/**
 * 评估一个指标值。
 *
 * <p>参考范围是**成人通用值**。这一点必须让患者知道，
 * 所以 rangeText 里带上"参考"二字，界面上也标注"以化验单上的
 * 参考范围为准"。
 */
export function evaluateMarker(reading: MarkerReading): MarkerEvaluation | null {
  // 血压的两个值不在 MARKERS 里（它们是数对，规则不同），单独查
  const def = MARKERS.find((m) => m.name === reading.name) ?? BP_DEFS[reading.name];
  if (!def) return null;

  const { value } = reading;
  let level: 'normal' | 'high' | 'low' = 'normal';
  if (def.high !== null && value > def.high) level = 'high';
  else if (def.low !== null && value < def.low) level = 'low';

  const rangeText = buildRangeText(def);

  return {
    name: def.name,
    value,
    unit: def.unit,
    level,
    rangeText,
    meaning:
      level === 'high'
        ? def.highMeaning
        : level === 'low'
          ? def.lowMeaning
          : '在常见参考范围内。',
    advice:
      level === 'high'
        ? def.highAdvice
        : level === 'low'
          ? def.lowAdvice
          : '保持现有习惯，按医生建议的时间复查即可。',
    department: def.department,
  };
}

function buildRangeText(def: MarkerDef): string {
  if (def.low !== null && def.high !== null) {
    return `${def.low}–${def.high} ${def.unit}`;
  }
  if (def.high !== null) {
    return `< ${def.high} ${def.unit}`;
  }
  if (def.low !== null) {
    return `> ${def.low} ${def.unit}`;
  }
  return '';
}

/** 一段文本 → 所有指标的评估结果 */
export function evaluateText(text: string): MarkerEvaluation[] {
  return extractMarkers(text)
    .map(evaluateMarker)
    .filter((x): x is MarkerEvaluation => x !== null);
}

/**
 * 从一批带日期的病历里，按指标名聚合成趋势。
 *
 * <p>这是「健康管家」与「一次性的报告解读」的本质区别：
 * 单次值只能说明"此刻怎样"，趋势才能说明"在往哪走"。
 *
 * @returns 每个指标一条，内含按日期升序的读数
 */
export interface MarkerTrend {
  name: string;
  unit: string;
  /** 按日期升序 */
  points: Array<{ date: string; value: number; level: 'normal' | 'high' | 'low' }>;
  /** 最新一次的值 */
  latest: number;
  /** 与上一次相比的变化。null 表示只有一个数据点 */
  delta: number | null;
  /** 一句话趋势描述 */
  trendText: string;
}

export function buildTrends(
  records: Array<{ visitDate: string; ocrText?: string | null; diagnosisBrief?: string | null }>,
): MarkerTrend[] {
  // 指标名 → 按日期收集
  const bucket = new Map<string, MarkerTrend>();

  const sorted = [...records].sort((a, b) => a.visitDate.localeCompare(b.visitDate));

  for (const r of sorted) {
    /*
     * **按字段分别抽取，不拼在一起。**
     *
     * 实测缺陷：原来拼成 `${ocrText} ${diagnosisBrief}` 再抽取，
     * 结果 "…糖化血红蛋白。" + "2型糖尿病复诊" 连起来后，
     * 正则跨过了字段边界，把诊断名里的 "2" 当成了糖化血红蛋白的值，
     * 界面上出现「糖化血红蛋白 2% 偏低」这种荒谬结论。
     *
     * 字段之间没有语义连续性，拼起来会让"名称 + 无关数字"
     * 恰好满足匹配条件。分开抽取就不会跨字段。
     */
    const evals = [
      ...evaluateText(r.ocrText ?? ''),
      ...evaluateText(r.diagnosisBrief ?? ''),
    ];

    // 同一次就诊里同一指标可能两个字段都有，只保留第一个（ocrText 优先）
    const seen = new Set<string>();
    for (const e of evals) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);

      let t = bucket.get(e.name);
      if (!t) {
        t = {
          name: e.name,
          unit: e.unit,
          points: [],
          latest: e.value,
          delta: null,
          trendText: '',
        };
        bucket.set(e.name, t);
      }
      t.points.push({ date: r.visitDate, value: e.value, level: e.level });
    }
  }

  const out = [...bucket.values()];
  for (const t of out) {
    t.points.sort((a, b) => a.date.localeCompare(b.date));
    t.latest = t.points[t.points.length - 1]!.value;
    t.delta =
      t.points.length >= 2
        ? Number((t.latest - t.points[t.points.length - 2]!.value).toFixed(2))
        : null;
    t.trendText = describeTrend(t);
  }

  return out;
}

function describeTrend(t: MarkerTrend): string {
  if (t.points.length === 1) {
    return `只记录过一次：${t.latest} ${t.unit}`;
  }
  const d = t.delta ?? 0;
  const arrow = d > 0 ? '上升' : d < 0 ? '下降' : '持平';
  const abs = Math.abs(d);
  if (abs === 0) {
    return `与上次持平（${t.latest} ${t.unit}）`;
  }
  return `比上次${arrow} ${abs} ${t.unit}（现在 ${t.latest} ${t.unit}）`;
}
