/* ------------------------------------------------------------------
 * 检查单解析 —— 「医生开完检查单，上传之后指引要跟着变」
 *
 * ============ 它解决什么 ============
 *
 * 到院指引原本是按科室和挂号信息推出来的固定流程：
 * 挂号 → 抽血 → 看诊 → 缴费 → 取报告 → 取药。
 *
 * 但真实情况是：**检查项目是医生看诊之后才决定的**。
 * 患者先看医生，医生开一张检查单（"胸部 CT 平扫""腹部彩超""抽血查甲功"），
 * 这时候该去哪、要不要空腹、要不要预约 —— 全都变了。
 * 系统如果还显示原来那条流程，就会把患者指到错误的楼层。
 *
 * 所以这一层做的是：从上传的检查单文本里抽出**具体开了哪些检查**，
 * 交给导航去决定"接下来去哪几站"。
 *
 * ============ 为什么复用 EXAM_ITEMS 而不是另建词典 ============
 *
 * `lib/exam/duplicate.ts` 已经有一份检查项目词典（用于跨院重复检查检测）。
 * 再建一份的话，两份迟早不一致 —— 而表现是"重复检查能识别，
 * 但指引里漏了那一站"，这种 bug 极难发现。
 *
 * 这里只做一件事：把自由文本里的项目名映射成**能驱动导航的结构化条目**
 * （地点类型 + 空腹要求 + 预计耗时）。
 *
 * ============ 诚实边界 ============
 *
 * 这是**规则匹配**，不是医学 NLP。检查单写"拟行增强 CT"能匹配到 CT，
 * 但写"遵医嘱"就什么都抽不出来。抽不到时的正确做法是
 * **明确告诉患者"没识别出检查项目，请以上面的原文为准"**，
 * 而不是假装解析成功。
 * ------------------------------------------------------------------ */

import { EXAM_ITEMS } from '../exam/duplicate';

/** 一条检查项目 —— 能驱动导航的结构化信息 */
export interface ParsedExam {
  /** 标准名，如「胸部 CT」 */
  name: string;
  /**
   * 对应院内地点类型（与后端 STAGE_ORDER 的 place_type 一致）。
   *
   * <p>只产出三种：
   *   · LAB   —— 抽血类（血糖、血脂、甲功…）
   *   · EXAM  —— 影像/内镜类（CT、超声、心电图…）
   *   · OTHER —— 识别到但归不了类，界面照原文展示
   */
  placeType: 'LAB' | 'EXAM' | 'OTHER';
  /** 是否需要空腹。true = 需要，false = 不需要，null = 检查单没写、我们不知道 */
  fasting: boolean | null;
  /** 检查单原文里命中的那一句，给患者核对用 */
  evidence: string;
}

/** 影像/内镜类关键词 —— 归到 EXAM 站 */
const IMAGING = /(CT|核磁|磁共振|MRI|X线|X光|胸片|超声|彩超|B超|内镜|胃镜|肠镜|心电图|动态心电|平板运动|造影)/i;

/** 抽血类关键词 —— 归到 LAB 站 */
const BLOODWORK = /(抽血|静脉血|血常规|生化|免疫|凝血|糖化|血糖|血脂|肝功|肾功|甲功|甲状腺功能|电解质|尿常规)/i;

/**
 * 空腹提示词。
 *
 * <p>只认明确的写法。"空腹"出现在检查单上通常是有意的
 * （"空腹血糖""空腹彩超"），所以命中就判需要空腹。
 * 反过来判断"不需要空腹"是很危险的 —— 漏判会让患者白跑一趟，
 * 所以这里**只在明确写了"无需空腹/不需空腹"时**才标 false。
 */
const FASTING_YES = /空腹|禁食|勿进食/;
const FASTING_NO = /无需空腹|不需空腹|不必空腹|正常饮食|无需禁食/;

/**
 * 从检查单文本里抽检查项目。
 *
 * @param text 已脱敏的检查单文本（原文留在本地）
 * @returns 抽到的项目；一个都没抽到时返回空数组
 */
export function parseExamOrder(text: string): ParsedExam[] {
  const raw = text.trim();
  if (!raw) return [];

  /*
   * 按行处理，而不是整段一次性匹配。
   *
   * 理由：检查单的"一行一项"是通行格式，而整段匹配会把
   * 前后文错配 —— 比如"空腹血糖"下面一行的"胸部 CT"会被
   * 误判成需要空腹。
   */
  const lines = raw.split(/\r?\n/).map((l) => l.trim());

  /** 用 name 去重：同一张单子上「胸片」和「胸部正位片」算一项 */
  const seen = new Map<string, ParsedExam>();
  const out: ParsedExam[] = [];

  const push = (parsed: ParsedExam) => {
    if (seen.has(parsed.name)) return;
    seen.set(parsed.name, parsed);
    out.push(parsed);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    /*
     * 一行里可能写多个项目（"空腹血糖、糖化血红蛋白"）。
     * 先按顿号/分号/逗号切成若干段，每段单独判断 ——
     * 不切的话整行只会被第一条命中的规则吃掉，后面的项目凭空消失，
     * 患者上传了检查单却少了一站。
     */
    const segments = line
      .split(/[、;；,，]/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const seg of segments) {
      // 1) 先看词典里的标准项目（复用 EXAM_ITEMS，不另建）
      const dictionaryHit = EXAM_ITEMS.find((item) => item.pattern.test(seg));
      if (dictionaryHit) {
        push({
          name: dictionaryHit.name,
          /*
           * 站别读词典自带的 placeType，不按名字猜。
           * 名字猜的老写法是 `/超声|B超/.test(name)` —— 词典里一加
           * 「胸部CT」，它就会被分到抽血站，患者被指到错误的楼层。
           */
          placeType: dictionaryHit.placeType,
          fasting: detectFasting(seg, line, lines[i - 1]),
          evidence: seg.slice(0, 80),
        });
        continue;
      }

      // 2) 词典没命中，再用宽泛的影像/抽血关键词兜一层
      if (IMAGING.test(seg)) {
        push({
          name: extractName(seg, 'EXAM'),
          placeType: 'EXAM',
          fasting: detectFasting(seg, line, lines[i - 1]),
          evidence: seg.slice(0, 80),
        });
        continue;
      }

      if (BLOODWORK.test(seg)) {
        push({
          name: extractName(seg, 'LAB'),
          placeType: 'LAB',
          fasting: detectFasting(seg, line, lines[i - 1]),
          evidence: seg.slice(0, 80),
        });
      }
    }
  }

  return out;
}

/**
 * 提取项目名。
 *
 * <p>不做完整的断句 —— 从"申请：胸部 CT 平扫"里抠出"胸部 CT 平扫"
 * 只需要去掉冒号前后的标签词和括号里的注记。
 * 抠不干净也没关系：这个名字只用于展示，患者对着原文核对。
 */
function extractName(seg: string, kind: 'EXAM' | 'LAB'): string {
  const cleaned = seg
    // 去掉"申请：""检查项目：""医嘱："这类前缀
    .replace(/^(申请|检查项目|项目|医嘱|开单|拟行|检查名称)[：:\s]*/, '')
    // 去掉尾部的括号注记（"（需预约）""（3天后取）"）
    .replace(/[（(][^）)]*[）)]\s*$/, '')
    .trim();

  if (!cleaned) return kind === 'EXAM' ? '影像检查' : '抽血检查';
  // 名字太长时截断：界面上一行放不下，且再长也不提升识别度
  return cleaned.slice(0, 40);
}

/**
 * 判断是否空腹。
 *
 * @param seg  当前这一段（一行可能被顿号切成几段）
 * @param line 当前整行
 * @param prev 上一行（检查单常把"空腹"单独写一行作为备注）
 */
function detectFasting(seg: string, line: string, prev?: string): boolean | null {
  // 明确说不用空腹的，优先判 false
  if (FASTING_NO.test(seg)) return false;
  if (FASTING_YES.test(seg)) return true;

  /*
   * 再看整行：逗号/顿号切出来的第二段往往不带"空腹"，
   * 但同一行的开头写了。比如「空腹血糖、糖化血红蛋白」——
   * 切之后"糖化血红蛋白"那一段没有"空腹"二字，但它属于同一张抽血单。
   */
  if (FASTING_NO.test(line)) return false;
  if (FASTING_YES.test(line)) return true;

  /*
   * 最后看上一行，但**只在它确实是备注时才看**。
   *
   * 判据有两条，缺一不可：
   *   · 够短（≤6 字）：检查单的备注行都很短，"空腹""需憋尿"这种
   *   · **本身不是检查项目**：这条是实测补上的 ——
   *     "空腹血糖"也是 4 个字，只按长度判断会把它当成备注，
   *     结果下面的"胸部 CT"被误判成需要空腹，患者白饿一早上。
   */
  if (prev && prev.length <= 6 && !isExamItemName(prev)) {
    if (FASTING_NO.test(prev)) return false;
    if (FASTING_YES.test(prev)) return true;
  }

  /*
   * 检查单没写——返回 null，不是 false。
   * 这个区别很重要：null 表示"我们不知道，界面上要提示患者确认"，
   * false 表示"确认不需要空腹"。把不知道当不需要，
   * 会让患者吃完饭才去做需要空腹的检查，当天白跑。
   */
  return null;
}

/** 这段文本本身是不是一个检查项目（词典命中或带影像/抽血关键词） */
function isExamItemName(text: string): boolean {
  return (
    EXAM_ITEMS.some((it) => it.pattern.test(text)) || IMAGING.test(text) || BLOODWORK.test(text)
  );
}

/**
 *
 * <p>导航用它决定抽血/检查排在最前还是正常顺序 ——
 * 和排程 Agent 的 buildTimeline 用的是同一条判据。
 */
export function needsFastingOverall(exams: readonly ParsedExam[]): boolean {
  return exams.some((e) => e.fasting === true);
}

/**
 * 有没有"不知道要不要空腹"的项目。
 *
 * <p>有的话界面必须提示患者去问 —— 这是本模块最重要的输出之一。
 */
export function hasUnknownFasting(exams: readonly ParsedExam[]): boolean {
  return exams.some((e) => e.fasting === null);
}

/** 按地点类型分组，给导航用 */
export function groupByPlaceType(
  exams: readonly ParsedExam[],
): { lab: ParsedExam[]; exam: ParsedExam[]; other: ParsedExam[] } {
  return {
    lab: exams.filter((e) => e.placeType === 'LAB'),
    exam: exams.filter((e) => e.placeType === 'EXAM'),
    other: exams.filter((e) => e.placeType === 'OTHER'),
  };
}
