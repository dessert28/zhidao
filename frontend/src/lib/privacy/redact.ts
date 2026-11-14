/* ------------------------------------------------------------------
 * 端侧 PII 脱敏 —— 「原文不出设备」的技术兑现
 * 依据：docs/06-AI用途全景.md ⑧ 端侧智能三件套（P0 第一件）
 *       docs/08 §1 隐私架构，docs/11 特别说明第 ⑤ 条
 *
 * 为什么必须做在端侧而不是服务端：
 *   如果在服务端脱敏，原文**已经离开设备了**，此时再脱敏，
 *   泄漏面已经发生（传输中、日志里、中间层都可能留下）。
 *   只有客户端先脱敏，才能说「原文从未离开这台设备」。
 *
 * 为什么不用 OpenMed 直接上：
 *   OpenMed 是 Python + 模型权重，浏览器里跑要转 ONNX。
 *   当前阶段先用规则引擎把链路打通（确定性、零延迟、可单测），
 *   ONNX 小模型作为增量加在同一个接口后面 —— 见 detectWithModel。
 *
 * 设计原则：
 *   宁可多遮蔽，不可漏遮蔽。姓名认错了，最多是文本读起来别扭；
 *   手机号漏了，是真的泄漏。
 * ------------------------------------------------------------------ */

/** 脱敏结果 */
export interface RedactionResult {
  /** 脱敏后文本，可直接发给服务端 */
  text: string;
  /** 命中记录。只记类型和位置，**不记原文** —— 这个对象可能被日志打印 */
  hits: RedactionHit[];
  /** 原文长度，用于展示"已遮蔽 N 处" */
  originalLength: number;
}

export interface RedactionHit {
  type: PiiType;
  /** 在原文中的起止位置 */
  start: number;
  end: number;
  /** 替换成的占位符 */
  placeholder: string;
}

export type PiiType =
  | 'id_card'
  | 'phone'
  | 'name'
  | 'address'
  | 'email'
  | 'bank_card'
  | 'medical_record_no';

/**
 * 规则表。顺序很重要：**先匹配长的、结构唯一的，再匹配模糊的**。
 * 身份证必须先于手机号（11 位数字是身份证的子串）。
 * 姓名必须最后（"张"可能是姓也可能是量词）。
 */
interface PiiRule {
  type: PiiType;
  pattern: RegExp;
  /** 保留首尾几位，中间打码；用于手机号这类可校验的 */
  mask: (m: string) => string;
}

const RULES: PiiRule[] = [
  {
    type: 'id_card',
    // 18 位身份证，末位可为 X
    pattern: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
    mask: (m) => `${m.slice(0, 4)}${'*'.repeat(10)}${m.slice(-4)}`,
  },
  {
    type: 'bank_card',
    // 16-19 位连续数字（去掉空格/横线后判断）
    pattern: /\b\d{16,19}\b/g,
    mask: (m) => `${m.slice(0, 4)}${'*'.repeat(m.length - 8)}${m.slice(-4)}`,
  },
  {
    type: 'phone',
    // 大陆手机号
    pattern: /\b1[3-9]\d{9}\b/g,
    mask: (m) => `${m.slice(0, 3)}****${m.slice(-4)}`,
  },
  {
    type: 'medical_record_no',
    // 就诊卡号/病历号：常见前缀 + 数字
    pattern: /(?:病历号|就诊卡号?|住院号|门诊号)[：:\s]*([A-Za-z0-9]{4,20})/g,
    mask: () => '［病历号已遮蔽］',
  },
  {
    type: 'email',
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    mask: (m) => {
      const [user, domain] = m.split('@');
      const head = (user ?? '').slice(0, 2);
      return `${head}***@${domain ?? ''}`;
    },
  },
  {
    type: 'address',
    // 省市区 + 街道门牌，或"XX 路/街/号"
    pattern:
      /(?:[\u4e00-\u9fa5]{2,8}(?:省|市|自治区))?[\u4e00-\u9fa5]{2,8}(?:区|县|镇)[\u4e00-\u9fa5]{0,12}(?:路|街|道|巷)[\u4e00-\u9fa5\d]{0,12}(?:号|弄|栋|单元|室)?/g,
    mask: () => '［住址已遮蔽］',
  },
  {
    type: 'name',
    // 中文姓名：常见姓氏 + 1-2 字名，前面常跟"我是/叫/患者"
    pattern:
      /(?:(?:我叫|我是|患者|姓名|病人)[：:\s]*)([\u4e00-\u9fa5]{2,4})(?=[，,。\s、的]|$)/g,
    mask: () => '［患者姓名］',
  },
];

/** 姓名正则的常见姓氏白名单 —— 降低误报（"我叫不上来"不该被遮蔽） */
const SURNAMES = new Set(
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫'.split(''),
);

/**
 * 执行脱敏。
 *
 * 实现要点：**从后往前替换**。
 * 如果从前往后替换，一旦替换文本长度和原文不同，
 * 后面记录的位置偏移就全错了。倒序替换天然规避这个问题。
 */
export function redact(raw: string): RedactionResult {
  const hits: RedactionHit[] = [];

  /** 记录已被某条规则占用的区间，防止嵌套重复遮蔽 */
  const taken: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) =>
    taken.some(([ts, te]) => s < te && e > ts);

  for (const rule of RULES) {
    // 每条规则都要重置 lastIndex（g 标志的正则是有状态的）
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = rule.pattern.exec(raw)) !== null) {
      // 有捕获组的规则（姓名/病历号）只替换捕获段，保留前面的标签
      const target = m[1] ?? m[0];
      const start = m.index + (m[0].length - target.length);
      const end = start + target.length;

      if (overlaps(start, end)) continue;

      // 姓名额外用姓氏白名单过滤，压误报
      if (rule.type === 'name' && !SURNAMES.has(target.charAt(0))) continue;

      taken.push([start, end]);
      hits.push({ type: rule.type, start, end, placeholder: rule.mask(target) });
    }
  }

  // 倒序替换，位置不漂移
  hits.sort((a, b) => b.start - a.start);
  let text = raw;
  for (const h of hits) {
    text = text.slice(0, h.start) + h.placeholder + text.slice(h.end);
  }

  // 对外返回正序，便于 UI 从前往后标注
  hits.sort((a, b) => a.start - b.start);

  return { text, hits, originalLength: raw.length };
}

/** 便捷判断：是否含 PII */
export function hasPii(raw: string): boolean {
  return redact(raw).hits.length > 0;
}

/**
 * 模型侧检测 —— 补规则引擎抓不到的自由叙述 PII。
 *
 * <p><b>分工要说清楚</b>：
 * <ul>
 *   <li>{@link redact} 管结构化 PII：身份证、手机号、银行卡、邮箱、带标签的地址。
 *       确定性、零延迟、可单测</li>
 *   <li>这个函数管**没有固定形状**的：「老王让我带他上次的片子」
 *       「我住梧桐里社区那边」。这部分只能靠 NER 模型</li>
 * </ul>
 *
 * <p>返回 {@code null} 表示模型不可用（未下载 / 加载失败 / 推理异常），
 * 调用方必须回退到纯规则结果。<b>不要把 null 当成"没有 PII"</b> ——
 * 那是两件完全不同的事，混起来会导致"以为检查过一遍，其实没检查"。
 *
 * <p>实现放在 {@code ner.ts}，因为它要动态 import 几 MB 的运行时，
 * 不能和这个纯函数模块绑在一起（本文件被首屏和测试大量引用）。
 */
export async function detectWithModel(
  raw: string,
): Promise<Array<{ type: PiiType; start: number; end: number; text: string }> | null> {
  // 用动态 import 保持本模块的"零依赖纯函数"性质：
  // 静态 import 会把 transformers.js 拖进任何引入 redact 的地方
  // （包括 ChatPage 首屏、以及 25 个单元测试）。
  const { detectEntities } = await import('./ner');
  const entities = await detectEntities(raw);
  return entities ? entities.map(({ type, start, end, text }) => ({ type, start, end, text })) : null;
}

/* ============================ 展示辅助 ============================ */

const TYPE_LABEL: Record<PiiType, string> = {
  id_card: '身份证号',
  phone: '手机号',
  name: '姓名',
  address: '住址',
  email: '邮箱',
  bank_card: '银行卡号',
  medical_record_no: '病历号',
};

/** 给人看的摘要：按类型计数，不暴露原文 */
export function summarizeHits(hits: RedactionHit[]): string {
  if (hits.length === 0) return '未检测到需要遮蔽的信息';
  const counts = new Map<PiiType, number>();
  for (const h of hits) counts.set(h.type, (counts.get(h.type) ?? 0) + 1);
  return [...counts.entries()]
    .map(([t, n]) => `${TYPE_LABEL[t]} ×${n}`)
    .join('、');
}
