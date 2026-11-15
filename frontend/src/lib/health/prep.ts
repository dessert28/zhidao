/* ------------------------------------------------------------------
 * 就诊准备清单 —— 「去之前要带什么、要注意什么」
 *
 * ============ 它解决什么 ============
 *
 * 患者最常白跑一趟的原因不是挂错号，是**准备错**：
 *   · 抽血要空腹，结果早上喝了豆浆
 *   · 要带旧片子，结果没带，医生让下次再来
 *   · 吃降压药的人不知道该不该停药
 *
 * 这个模块根据「挂什么科 + 做什么检查 + 患者自己的情况」，
 * 生成一份具体的清单。
 *
 * ============ 一条硬规矩：不替医生决定停药 ============
 *
 * 「明天要抽血，降压药还要不要吃」这类问题，答案取决于具体药物
 * 与检查项目，必须问医生。我们能做的是**提醒他一定要问**，
 * 而不是给一个可能是错的答案。
 * 所以相关条目写成「请提前问医生」，而不是「可以停」或「必须停」。
 * ------------------------------------------------------------------ */

import type { MedicalRecord } from '../api';

/** 清单条目 */
export interface PrepItem {
  /** 标题，如「空腹 8 小时」 */
  title: string;
  /** 具体怎么做 */
  detail: string;
  /** 重要程度：must 必须 / should 建议 / ask 需要问医生 */
  level: 'must' | 'should' | 'ask';
  /** 为什么 —— 患者知道原因才愿意遵守 */
  why: string;
}

/** 生成清单的输入 */
export interface PrepInput {
  /** 科室，如「内分泌科」 */
  department: string;
  /** 是否需要空腹（来自院内地点配置或科室规则） */
  needsFasting?: boolean;
  /** 患者是否在服药 */
  hasMedications?: boolean;
  /** 患者慢病 */
  chronics?: string[];
  /** 历史病历（用于判断是否需要带旧报告） */
  records?: MedicalRecord[];
}

/**
 * 需要空腹的检查/科室。
 *
 * <p>收紧到"明确要求空腹"的场景：血糖、血脂、肝功能、腹部超声、
 * 内分泌科多数检查。
 * 不把所有抽血都算进去 —— 血常规不需要空腹，
 * 让患者白饿一早上是实实在在的伤害。
 */
const FASTING_DEPARTMENTS = /内分泌|消化内科/;
const FASTING_TESTS = /(空腹血糖|血脂|肝功能|腹部超声|糖耐量|胰岛素释放)/;

/** 生成就诊准备清单 */
export function buildPrepList(input: PrepInput): PrepItem[] {
  const items: PrepItem[] = [];
  const { department, needsFasting, hasMedications, chronics = [], records = [] } = input;

  /* ---------- 1. 空腹 ---------- */
  if (needsFasting || FASTING_DEPARTMENTS.test(department)) {
    items.push({
      title: '空腹前往（前一晚 22 点后禁食）',
      detail:
        '抽血前需空腹 8-12 小时。前一晚 22 点后不要吃东西，可以少量喝白开水（不超过 200ml）。不要喝含糖饮料、牛奶、豆浆。',
      level: 'must',
      why: '进食后血糖、血脂会明显升高，结果不准，可能需要重新抽一次。',
    });
  }

  /* ---------- 2. 带既往资料 ---------- */
  if (records.length > 0) {
    items.push({
      title: `带上既往检查报告（你有 ${records.length} 份病历）`,
      detail:
        '把之前的化验单、影像报告带上，尤其在其他医院做过的。医生需要对比才能判断趋势。',
      level: 'must',
      why: '没有旧报告，医生可能让你把已经做过的检查再做一遍。',
    });
  }

  /* ---------- 3. 用药清单 ---------- */
  if (hasMedications) {
    items.push({
      title: '带上完整用药清单',
      detail:
        '把正在吃的药拍照或写下来，包括药名、剂量、一天几次。中成药、保健品也要算进去。',
      level: 'must',
      why: '医生开新药前必须知道你已经在吃什么，否则可能重复开或相互作用。',
    });

    /*
     * 这一条刻意写成「问医生」而不是给答案。
     * 见文件头的说明：停不停药取决于药物与检查项目，
     * 我们给不出正确答案，给错了比不给更糟。
     */
    items.push({
      title: '需要问医生：检查当天药要不要吃',
      detail:
        '排队或进诊室时问一句「我吃的这些药，检查当天要不要停」。不要自己停药或改量。',
      level: 'ask',
      why: '有些药会影响检查结果，有些停了反而危险。这必须由医生根据你的具体用药判断。',
    });
  }

  /* ---------- 4. 慢病相关 ---------- */
  if (chronics.some((c) => /糖尿病|高血压/.test(c))) {
    items.push({
      title: '带上近期的自测记录',
      detail:
        '糖尿病：带上最近一两周的血糖记录（含时间）。高血压：带上早晚血压记录。',
      level: 'should',
      why: '门诊时间有限，有记录医生才能判断现在的方案要不要调整，而不是让你回去再测两周。',
    });
  }

  /* ---------- 5. 通用 ---------- */
  items.push({
    title: '带身份证 / 医保卡 / 就诊卡',
    detail: '提前确认医保是否已绑定，外地医保要先备案。',
    level: 'must',
    why: '没有医保卡可能无法报销，事后补办很麻烦。',
  });

  items.push({
    title: '提前 20 分钟到，先在分诊台报到',
    detail:
      '到了先到科室分诊台或自助机二次报到，否则可能过了号要重新排。',
    level: 'should',
    why: '很多医院过号后需要重新排队，白等一两个小时。',
  });

  return items;
}

/** 按重要程度排序：必须 > 建议 > 需要问 */
export function sortPrepItems(items: PrepItem[]): PrepItem[] {
  const order: Record<PrepItem['level'], number> = { must: 0, ask: 1, should: 2 };
  return [...items].sort((a, b) => order[a.level] - order[b.level]);
}

/** 一句话摘要，给卡片标题用 */
export function summarizePrep(items: PrepItem[]): string {
  const must = items.filter((i) => i.level === 'must');
  if (must.length === 0) return '按常规准备即可';
  return `${must.length} 项必须做：${must.map((i) => i.title).join('、')}`;
}

/** 判断某个科室是否需要空腹 —— 供其他地方复用 */
export function departmentNeedsFasting(department: string, text = ''): boolean {
  return FASTING_DEPARTMENTS.test(department) || FASTING_TESTS.test(text);
}
