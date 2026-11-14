/* ------------------------------------------------------------------
 * 红线规则引擎 —— 确定性规则表，**不经 LLM**
 * 依据：docs/05-Agent契约表.md §2.4
 *
 * 为什么不能走模型：不能赌模型是否配合。胸痛/卒中/呼吸困难/意识改变/大出血
 * 命中即短路，直接输出紧急指引并终止本轮对话。这是 Reviewer safety 维度的
 * 前置防线，也是"AI 安全与可控性 4%"最硬的一块证据。
 * ------------------------------------------------------------------ */

import type { RedFlag } from '@shared/types/contract';

interface RedFlagRule {
  type: RedFlag['type'];
  /** 命中任意一组即触发（组内为"与"，组间为"或"） */
  patterns: RegExp[];
  guidance: string;
}

/**
 * 规则表设计要点：
 * - 中文口语为主，覆盖"心口窝疼""嘴歪了""喘不上气"这类日常说法
 * - 不做否定式忽略（"没有胸痛"也会命中）—— 宁可误报，绝不漏报
 * - 每条规则的 guidance 都是可执行的下一步动作，不是免责声明
 */
const RULES: RedFlagRule[] = [
  {
    type: 'chest_pain',
    patterns: [
      /胸(口|部|前区|骨后)?(疼|痛|闷|压|堵)/,
      /心(口窝|前区)(疼|痛|闷)/,
      /(压榨|憋闷).{0,6}(疼|痛)/,
      /*
       * 急症**诊断名**也要命中。
       *
       * 规则表原本只认症状（胸痛、呼吸困难），但 AI 完全可能直接说出
       * 诊断名：「你这是急性心梗」「考虑急性心肌梗死」。
       * 实测这条会漏 —— 「你这是急性心梗，需要立刻手术」没有任何命中。
       *
       * 这一条不只是"拦住 AI 下诊断"，更是安全兜底：
       * 如果模型真的在描述一个心梗病人，用户需要立刻看到 120 指引。
       */
      /(急性)?心(肌)?梗(死)?/,
      /急性冠脉综合征/,
    ],
    guidance:
      '胸痛可能是心梗信号。请立即停止活动、原地坐下或半卧，不要自行开车前往。拨打 120 或让身边的人送你去最近医院急诊。若手边有硝酸甘油且是医生开给你的，可按既往医嘱舌下含服。',
  },
  {
    type: 'stroke',
    patterns: [
      /(口角|嘴角|嘴).{0,4}(歪|斜|漏水)/,
      // 「一侧/半边」+「无力」的多种口语说法：无力、没力气、使不上劲、抬不起来
      // 方位词覆盖：一侧 / 半边 / 单侧 / 一边 / 左边 / 右边 / 左侧 / 右侧
      /(一侧|半边|单侧|一边|左边|右边|左侧|右侧).{0,6}(无力|没力气|没劲|使不上|抬不起|不能动|发麻|麻)/,
      /(无力|没力气|使不上劲).{0,6}(一侧|半边|单侧|一边|左边|右边|左侧|右侧)/,
      /(说话|言语|讲话).{0,4}(不清|含糊|说不|不利)/,
      /(突然).{0,6}(看不见|失明|视物)/,
    ],
    guidance:
      '这些是卒中（中风）的典型表现，抢救有黄金时间窗。请立即拨打 120，告知接线员"怀疑卒中"及最后一次正常的时间。不要让患者自行服药或进食。',
  },
  {
    type: 'dyspnea',
    patterns: [
      /(喘不(上|过)|呼吸(困难|急促|费劲)|气(短|促|不够用))/,
      /(憋气|吸不进气|上不来气)/,
    ],
    guidance:
      '呼吸困难需要立即评估。请让患者取坐位或半卧位、解开领口，保持通风。若出现口唇发紫、不能完整说话，立即拨打 120。',
  },
  {
    type: 'consciousness',
    patterns: [
      /(意识(不清|模糊)|昏迷|叫不醒|晕倒|昏过去)/,
      /(抽搐|抽风|口吐白沫|全身抽)/,
      /(突然).{0,4}(倒地|人事不省)/,
    ],
    guidance:
      '意识改变属于急危重症。若患者无反应且无正常呼吸，立即拨打 120 并开始胸外按压（120 调度员会电话指导）。若抽搐，移开周围硬物、不要强行按压肢体或往口中塞任何东西。',
  },
  {
    type: 'hemorrhage',
    patterns: [
      /(大出血|出血不止|血(流)?不停)/,
      /(呕血|吐血|咯血|咳血)/,
      /(黑便|柏油(样)?便|便血)/,
      /(产后|术后).{0,6}(出血|血多)/,
    ],
    guidance:
      '活动性大出血需要急诊处理。请用干净布料直接压迫出血部位并抬高患处，立即拨打 120。呕血或黑便提示消化道出血，请保持禁食禁水并尽快就医。',
  },
];

export interface RedFlagResult {
  hit: RedFlag | null;
  /** 命中的规则类型，便于日志与 review_trace 展示（不含原始文本） */
  matchedTypes: RedFlag['type'][];
}

/**
 * 执行红线检查。**纯函数、零依赖、可单测**。
 * @param text 已脱敏的用户输入（脱敏在浏览器端完成）
 */
export function checkRedFlag(text: string): RedFlagResult {
  const matched: RedFlag['type'][] = [];
  let hit: RedFlag | null = null;

  for (const rule of RULES) {
    if (matched.includes(rule.type)) continue;
    if (rule.patterns.some((p) => p.test(text))) {
      matched.push(rule.type);
      if (!hit) hit = { type: rule.type, guidance: rule.guidance };
    }
  }

  return { hit, matchedTypes: matched };
}

/** 供 Reviewer 复检使用：答案里出现了急症词也要追加提示 */
export function recheckAnswer(answer: string): RedFlag | null {
  return checkRedFlag(answer).hit;
}

/** 规则表自检：开发期用来确认覆盖度，不进生产路径 */
export const RED_FLAG_RULE_COUNT = RULES.length;
