/* ------------------------------------------------------------------
 * 报告术语词库 —— 「把词翻成白话」，不是「把结果翻成结论」
 *
 * ============ 这个文件存在的理由 ============
 *
 * 患者拿到报告，真正卡住的地方不是数字高低，是那几个词：
 * 「磨玻璃密度影」「窦性心律」「低回声结节」「不典型增生」。
 * 他们要么上网搜（搜到的是别人的病），要么就这么放着。
 *
 * 所以这里只做一件事：**解释这个词在医学上指什么**。
 *
 * ============ 三条不能越的线 ============
 *
 *   1. 不评价轻重。不写「这很严重」「这个不要紧」——
 *      同样的词在不同部位、不同大小、不同人身上含义不同。
 *   2. 不给下一步。不写「需要复查」「建议手术」——
 *      复查建议只能来自报告原文本身，不是我们加的。
 *   3. 不推测疾病。不写「常见于肺癌」——
 *      一写就变成诊断，这是医疗合规的红线（docs/08 §2）。
 *
 * 每条解释都只是一句「它描述的是什么现象」。
 * 界面上的免责脚注与这里的措辞是配套的，改一处要看另一处。
 * ------------------------------------------------------------------ */

/** 术语所属的报告类别，只用于分组展示 */
export type GlossaryCategory = '影像' | '心电' | '内镜' | '病理' | '化验' | '通用';

export interface GlossaryEntry {
  /** 展示名。与实际匹配到的写法可能不同（如原文写「磨玻璃影」） */
  term: string;
  /** 匹配原文用的正则。不带 g 标志，命中位置由 search 取得 */
  pattern: RegExp;
  /** 一句白话解释：这个词描述的是什么现象 */
  explanation: string;
  category: GlossaryCategory;
}

/**
 * 词库。
 *
 * <p><b>排序有讲究</b>：长词在前（「部分实性结节」先于「实性结节」，
 * 「淋巴结转移」先于「淋巴结」）。但仅靠顺序不够 ——
 * 原文里两个词完全可能同时出现，所以 findTerms 还会做一次区间去重，
 * 长词占据的位置不会被短词重复标注。
 */
export const GLOSSARY: GlossaryEntry[] = [
  /* ---------------------------- 影像 · 肺部 ---------------------------- */
  {
    term: '磨玻璃密度影',
    pattern: /磨玻璃(?:密度|样)?(?:影|结节)|GGO/i,
    explanation: '影像上一小片淡淡的、像磨砂玻璃一样的影子，能隐约看到后面的血管或支气管轮廓。',
    category: '影像',
  },
  {
    term: '部分实性结节',
    pattern: /部分实性结节|混合磨玻璃结节/,
    explanation: '既有磨玻璃那样淡的部分、又有实心部分的结节。',
    category: '影像',
  },
  {
    term: '实性结节',
    pattern: /实性结节/,
    explanation: '影像上一小块完全实心的阴影，看不到后面的组织轮廓。',
    category: '影像',
  },
  {
    term: '结节',
    pattern: /结节/,
    explanation: '影像上一个局限的、小的团块状阴影，报告通常用直径（毫米）描述它的大小。',
    category: '影像',
  },
  {
    term: '斑片影',
    pattern: /斑片(?:状)?影|斑片状/,
    explanation: '影像上一片边缘模糊、形状不规则的阴影。',
    category: '影像',
  },
  {
    term: '条索影',
    pattern: /条索(?:状)?影/,
    explanation: '影像上一条细线状的高密度影子，常是组织修复后留下的痕迹。',
    category: '影像',
  },
  {
    term: '肺纹理',
    pattern: /肺纹理/,
    explanation: '胸片上由血管、支气管等结构投影形成的树枝状纹理。',
    category: '影像',
  },
  {
    term: '胸膜',
    pattern: /胸膜/,
    explanation: '覆盖在肺表面和胸腔内侧的一层薄膜，两层之间有少量液体起润滑作用。',
    category: '影像',
  },

  /* ---------------------------- 影像 · 通用征象 ---------------------------- */
  {
    term: '钙化',
    pattern: /钙化/,
    explanation: '组织里出现了钙盐沉积，在影像上表现为很亮的白点或白块。',
    category: '影像',
  },
  {
    term: '高密度影',
    pattern: /高密度(?:影|灶)/,
    explanation: '在 CT 上比周围组织更亮的一片区域。',
    category: '影像',
  },
  {
    term: '低密度影',
    pattern: /低密度(?:影|灶)/,
    explanation: '在 CT 上比周围组织更暗的一片区域。',
    category: '影像',
  },
  {
    term: '强化',
    pattern: /强化|增强扫描/,
    explanation: '注射造影剂后某块区域变得更亮，说明那里血流比较丰富。',
    category: '影像',
  },
  {
    term: '边界清楚',
    pattern: /边界(?:清|清楚|清晰)/,
    explanation: '阴影和周围组织的分界比较明显，容易分得开。',
    category: '影像',
  },
  {
    term: '边界不清',
    pattern: /边界(?:不清|模糊)/,
    explanation: '阴影和周围组织的分界不分明，不太容易分得开。',
    category: '影像',
  },
  {
    term: '形态规则',
    pattern: /形态(?:规则|规整)/,
    explanation: '阴影的形状比较接近圆形或椭圆形，比较整齐。',
    category: '影像',
  },
  {
    term: '形态不规则',
    pattern: /形态(?:不规则|不规整)/,
    explanation: '阴影的形状不整齐，边缘有起伏或分叶。',
    category: '影像',
  },
  {
    term: '占位',
    pattern: /占位/,
    explanation: '某个位置多出来一块组织，占据了原本属于正常结构的空间。',
    category: '影像',
  },
  {
    term: '增厚',
    pattern: /增厚/,
    explanation: '某处的管壁或黏膜比通常情况厚。',
    category: '影像',
  },
  {
    term: '积液',
    pattern: /积液/,
    explanation: '在体腔（例如胸腔、关节腔）里积存了液体。',
    category: '影像',
  },
  {
    term: '狭窄',
    pattern: /狭窄/,
    explanation: '管腔（血管、气道、肠管等）的通道变窄。',
    category: '影像',
  },
  {
    term: '结石',
    pattern: /结石/,
    explanation: '器官或管道里形成的固体块状物。',
    category: '影像',
  },
  {
    term: '囊肿',
    pattern: /囊肿/,
    explanation: '一个里面有液体的囊状结构。',
    category: '影像',
  },
  {
    term: '息肉',
    pattern: /息肉/,
    explanation: '黏膜表面多长出来的一小块组织。',
    category: '影像',
  },
  {
    term: '肿大',
    pattern: /肿大/,
    explanation: '某个器官的体积比通常情况大。',
    category: '影像',
  },
  {
    term: '淋巴结',
    pattern: /淋巴结(?!转移)/,
    explanation: '沿淋巴管分布的小豆状结构，影像报告里常描述它的大小和形态。',
    category: '影像',
  },
  {
    term: '退行性变',
    pattern: /退行性(?:变|改变)/,
    explanation: '骨骼或关节随年龄出现的磨损性改变，报告里常写作「退行性变」。',
    category: '影像',
  },
  {
    term: '骨质增生',
    pattern: /骨质增生|骨刺/,
    explanation: '骨头边缘多长出的一小部分骨质，俗称骨刺。',
    category: '影像',
  },
  {
    term: '椎间盘突出',
    pattern: /椎间盘突出/,
    explanation: '椎间盘向后方鼓出，超出了椎体边缘的范围。',
    category: '影像',
  },
  {
    term: '椎间盘膨出',
    pattern: /椎间盘膨出/,
    explanation: '椎间盘整体向外鼓出，鼓出的程度比「突出」轻一些。',
    category: '影像',
  },
  {
    term: '斑块',
    pattern: /斑块/,
    explanation: '血管壁上附着的一层沉积物，报告通常写它的厚度。',
    category: '影像',
  },
  {
    term: '内膜中层厚度',
    pattern: /内膜中层厚度|内[-－]?中膜厚度|IMT/i,
    explanation: '超声测量的血管壁厚度，是颈动脉超声报告的常见指标。',
    category: '影像',
  },
  {
    term: '心影增大',
    pattern: /心影(?:增大|饱满)/,
    explanation: '胸片上心脏轮廓的投影比通常情况大。',
    category: '影像',
  },

  /* ---------------------------- 影像 · 超声 ---------------------------- */
  {
    term: '无回声',
    pattern: /无回声/,
    explanation: '超声上呈现为纯黑的区域，通常代表那里是液体。',
    category: '影像',
  },
  {
    term: '低回声',
    pattern: /低回声/,
    explanation: '超声上呈现为较暗的区域，说明那里反射回来的声波较少。',
    category: '影像',
  },
  {
    term: '高回声',
    pattern: /高回声/,
    explanation: '超声上呈现为较亮的区域，说明那里反射回来的声波较多。',
    category: '影像',
  },
  {
    term: '强回声',
    pattern: /强回声/,
    explanation: '超声上呈现为很亮的区域，常出现在钙化或结石处。',
    category: '影像',
  },
  {
    term: '回声均匀',
    pattern: /回声(?:均匀|尚均匀)/,
    explanation: '超声上这块区域内部的明暗比较一致。',
    category: '影像',
  },
  {
    term: '回声不均',
    pattern: /回声(?:不均匀|不均|欠均匀)/,
    explanation: '超声上这块区域内部的明暗不一致，有的地方亮有的地方暗。',
    category: '影像',
  },
  {
    term: '血流信号',
    pattern: /血流信号/,
    explanation: '多普勒超声用来显示某个区域里有没有血流、血流多不多。',
    category: '影像',
  },
  {
    term: '脂肪肝',
    pattern: /脂肪肝/,
    explanation: '肝细胞内堆积了较多脂肪，超声上表现为肝区回声增强。',
    category: '影像',
  },
  {
    term: 'TI-RADS',
    pattern: /TI[-\s]?RADS/i,
    explanation: '超声医生按甲状腺结节的影像特征给出的一种分级标记，各级的具体含义请让超声医生解释。',
    category: '影像',
  },
  {
    term: 'BI-RADS',
    pattern: /BI[-\s]?RADS/i,
    explanation: '影像医生按乳腺检查所见给出的一种分级标记，各级的具体含义请让报告医生解释。',
    category: '影像',
  },

  /* ---------------------------- 心电 ---------------------------- */
  {
    term: '窦性心律',
    pattern: /窦性心律/,
    explanation: '心脏由正常的起搏点（窦房结）发出节律，是最常见的一种心律。',
    category: '心电',
  },
  {
    term: '窦性心动过缓',
    pattern: /窦性心动过缓/,
    explanation: '仍是窦性心律，但心率低于每分钟 60 次。',
    category: '心电',
  },
  {
    term: '窦性心动过速',
    pattern: /窦性心动过速/,
    explanation: '仍是窦性心律，但心率高于每分钟 100 次。',
    category: '心电',
  },
  {
    term: '心律不齐',
    pattern: /心律不齐/,
    explanation: '心跳之间的间隔不完全一致。',
    category: '心电',
  },
  {
    term: '早搏',
    pattern: /早搏|期前收缩/,
    explanation: '心脏比预期提前跳了一次，之后常跟一个较长的停顿。',
    category: '心电',
  },
  {
    term: 'ST 段',
    pattern: /ST\s*段/i,
    explanation: '心电图上 QRS 波群结束到 T 波开始之间的那一段。',
    category: '心电',
  },
  {
    term: 'T 波改变',
    pattern: /T\s*波(?:改变|倒置|低平|平坦)/i,
    explanation: '心电图上 T 波的形状、方向或高低与常见图形不同。',
    category: '心电',
  },
  {
    term: '束支传导阻滞',
    pattern: /束支传导阻滞/,
    explanation: '电信号在心室内传导的某条通路（左或右束支）上传得比正常慢。',
    category: '心电',
  },
  {
    term: '传导阻滞',
    pattern: /传导阻滞/,
    explanation: '电信号从心房传到心室的过程中变慢或中断。',
    category: '心电',
  },

  /* ---------------------------- 内镜 ---------------------------- */
  {
    term: '充血',
    pattern: /充血/,
    explanation: '黏膜表面的血管扩张，看起来比周围更红。',
    category: '内镜',
  },
  {
    term: '水肿',
    pattern: /水肿/,
    explanation: '组织里液体增多，看起来比正常肿胀。',
    category: '内镜',
  },
  {
    term: '糜烂',
    pattern: /糜烂/,
    explanation: '黏膜表层出现的浅表破损，深度比溃疡浅。',
    category: '内镜',
  },
  {
    term: '溃疡',
    pattern: /溃疡/,
    explanation: '黏膜缺损得比较深，已经超过表层。',
    category: '内镜',
  },
  {
    term: '萎缩',
    pattern: /萎缩/,
    explanation: '黏膜比正常变薄、腺体减少。',
    category: '内镜',
  },
  {
    term: '肠上皮化生',
    pattern: /肠上皮化生|肠化/,
    explanation: '胃黏膜上出现了类似肠黏膜的细胞，是病理上的一种形态描述。',
    category: '内镜',
  },
  {
    term: '活检',
    pattern: /活检/,
    explanation: '用内镜上的小钳子取一小块组织下来，送病理科化验。',
    category: '内镜',
  },
  {
    term: '幽门螺杆菌',
    pattern: /幽门螺杆菌/,
    explanation: '一种常寄生在胃黏膜上的细菌，检查报告里可能写作「HP」。',
    category: '内镜',
  },
  {
    term: '反流',
    pattern: /反流/,
    explanation: '胃或十二指肠里的内容物倒流回上方。',
    category: '内镜',
  },
  {
    term: '贲门',
    pattern: /贲门/,
    explanation: '食管与胃连接的那一段部位名称。',
    category: '内镜',
  },
  {
    term: '胃窦',
    pattern: /胃窦/,
    explanation: '胃的下半部分、靠近幽门的一段部位名称。',
    category: '内镜',
  },
  {
    term: '十二指肠球部',
    pattern: /十二指肠球部/,
    explanation: '十二指肠紧接胃的那一小段，内镜下呈球形，是溃疡的常见部位。',
    category: '内镜',
  },

  /* ---------------------------- 病理 ---------------------------- */
  {
    term: '不典型增生',
    pattern: /不典型增生|异型增生/,
    explanation: '细胞形态与正常细胞有差异，病理报告会按差异程度分级。',
    category: '病理',
  },
  {
    term: '原位癌',
    pattern: /原位癌/,
    explanation: '异常细胞局限在黏膜表层以内，还没有突破底部的基底膜。',
    category: '病理',
  },
  {
    term: '淋巴结转移',
    pattern: /淋巴结转移/,
    explanation: '在淋巴结里也查到了异常细胞。',
    category: '病理',
  },
  {
    term: '免疫组化',
    pattern: /免疫组化/,
    explanation: '用抗体标记组织中特定蛋白的检查方法，结果通常写作「某某(+)」。',
    category: '病理',
  },
  {
    term: '切缘',
    pattern: /切缘/,
    explanation: '手术切下来的那块组织的边缘；报告会说明边缘有没有查到异常细胞。',
    category: '病理',
  },
  {
    term: '良性',
    pattern: /良性/,
    explanation: '病理上细胞形态与正常组织接近，没有向周围组织侵犯的表现。',
    category: '病理',
  },
  {
    term: '恶性',
    pattern: /恶性/,
    explanation: '病理上细胞形态明显不同于正常组织，并且有向周围组织侵犯的表现。',
    category: '病理',
  },

  /* ---------------------------- 化验 / 通用 ---------------------------- */
  {
    term: '参考范围',
    pattern: /参考(?:范围|值|区间)/,
    explanation: '检验科给出的一个数值区间，多数健康人的结果落在这个区间内。',
    category: '化验',
  },
  {
    term: '阴性',
    pattern: /阴性/,
    explanation: '没有检测到该项物质，或该项反应没有出现。',
    category: '化验',
  },
  {
    term: '阳性',
    pattern: /阳性/,
    explanation: '检测到了该项物质，或该项反应出现了。',
    category: '化验',
  },
  {
    term: '定量',
    pattern: /定量/,
    explanation: '测出具体数值的检查方式，结果是一个数字。',
    category: '化验',
  },
  {
    term: '定性',
    pattern: /定性/,
    explanation: '只判断有或没有的检查方式，结果通常是阴性或阳性。',
    category: '化验',
  },
  {
    term: '血清',
    pattern: /血清/,
    explanation: '血液凝固后分离出来的淡黄色液体部分，很多化验用的是它。',
    category: '化验',
  },
  {
    term: '全血',
    pattern: /全血/,
    explanation: '没有分离过的完整血液，血常规常用。',
    category: '化验',
  },
  {
    term: '标本',
    pattern: /标本/,
    explanation: '送去化验的那份材料，例如一管血、一份尿。',
    category: '化验',
  },
  {
    term: '结合临床',
    pattern: /结合临床/,
    explanation: '意思是这项结果需要和症状、其他检查一起看，单看它说明不了什么。',
    category: '通用',
  },
  {
    term: '待排',
    pattern: /待排|不除外|待除外/,
    explanation: '报告里表示某种情况还不能完全排除，需要医生结合其他资料判断。',
    category: '通用',
  },
  {
    term: '复查',
    pattern: /复查|随访/,
    explanation: '报告原文里医生写的「过一段时间再检查一次」，具体时间以报告和医嘱为准。',
    category: '通用',
  },
  {
    term: '进一步检查',
    pattern: /进一步(?:检查|诊治|明确)/,
    explanation: '报告原文里医生写的「还需要做别的检查来弄清楚」，具体做什么以医嘱为准。',
    category: '通用',
  },
];

/** 命中结果 */
export interface TermHit {
  term: string;
  explanation: string;
  category: GlossaryCategory;
  /** 在原文中的起始位置，用于按出现顺序排列 */
  at: number;
  /** AI 补的词打这个标记，和内置词库区分开 */
  fromAi?: boolean;
}

/**
 * 在文本里找术语。
 *
 * <p><b>为什么要有区间去重</b>：原文「部分实性结节」会同时命中
 * 「实性结节」和「结节」。不去重的话，一句话下面会挂三条注解，
 * 患者看到的是同一件事被说了三遍，可信度反而下降。
 *
 * <p>做法是长词优先占位，短词只要和已占区间有重叠就丢弃。
 * 注意不是「包含」而是「重叠」——「磨玻璃结节」和「结节」是包含关系，
 * 但「斑片影」与「条索影」这种相邻不重叠的必须都保留。
 */
export function findTerms(text: string): TermHit[] {
  if (!text?.trim()) return [];

  const matched: TermHit[] = [];
  for (const entry of GLOSSARY) {
    const m = entry.pattern.exec(text);
    if (!m) continue;
    matched.push({
      term: entry.term,
      explanation: entry.explanation,
      category: entry.category,
      at: m.index,
      fromAi: false,
    });
  }

  // 长词优先，逐条判断区间是否已被更长的命中占用
  const kept: TermHit[] = [];
  const sorted = [...matched].sort((a, b) => {
    const la = termLengthInText(text, a);
    const lb = termLengthInText(text, b);
    return lb - la || a.at - b.at;
  });

  for (const hit of sorted) {
    const len = termLengthInText(text, hit);
    const end = hit.at + len;
    const overlaps = kept.some((k) => {
      const kLen = termLengthInText(text, k);
      return hit.at < k.at + kLen && k.at < end;
    });
    if (!overlaps) kept.push(hit);
  }

  return kept.sort((a, b) => a.at - b.at);
}

/** 实际匹配到的原文片段长度（不能直接用 term.length，「磨玻璃密度影」原文可能是「磨玻璃影」） */
function termLengthInText(text: string, hit: TermHit): number {
  const entry = GLOSSARY.find((e) => e.term === hit.term);
  if (!entry) return hit.term.length;
  const m = entry.pattern.exec(text);
  return m ? m[0].length : hit.term.length;
}
