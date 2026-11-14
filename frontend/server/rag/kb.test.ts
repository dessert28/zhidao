/* ------------------------------------------------------------------
 * 知识库内容合规测试
 *
 * 为什么这类测试值得写：知识库是**模型引用给患者的原文**。
 * 里面的每一句话都会被当作"有依据的建议"直接呈现给用户，
 * 所以它比代码更需要被规则约束。
 *
 * 三条规范（kb.ts 文件头写了）：
 *   1. 只写"做什么"，不写"是什么病"
 *   2. 可量化的值给区间和单位，不给结论
 *   3. 涉及用药的一律指向"遵医嘱"
 *
 * 人工复核 20 条内容很难保证不漏，而规则可以每次都跑一遍。
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { KB_DOCS } from './kb';

describe('知识库结构', () => {
  it('条目数足够覆盖常见导诊场景', () => {
    // 10 条时"感冒了要不要吃抗生素"完全检索不到 —— 那是导诊最高频的问题之一
    expect(KB_DOCS.length).toBeGreaterThanOrEqual(20);
  });

  it('docId 唯一', () => {
    const ids = KB_DOCS.map((d) => d.docId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条都有 source / title / content / departments / tags', () => {
    for (const d of KB_DOCS) {
      expect(d.source, d.docId).toBeTruthy();
      expect(d.title, d.docId).toBeTruthy();
      expect(d.content.length, `${d.docId} 内容过短`).toBeGreaterThan(30);
      expect(d.departments.length, `${d.docId} 缺科室`).toBeGreaterThan(0);
      expect(d.tags.length, `${d.docId} 缺标签`).toBeGreaterThan(0);
    }
  });

  it('每个条目的科室都能在分诊体系里找到对应', () => {
    // 科室名必须与 Triage 使用的一致，否则检索到的资料挂不上科室
    const KNOWN = [
      '内分泌科',
      '心血管内科',
      '消化内科',
      '呼吸内科',
      '神经内科',
      '骨科',
      '皮肤科',
      '妇科',
      '眼科',
      '口腔科',
      '耳鼻咽喉科',
      '全科医学科',
      '儿科',
    ];
    for (const d of KB_DOCS) {
      for (const dept of d.departments) {
        expect(KNOWN, `${d.docId} 的科室「${dept}」不在分诊体系内`).toContain(dept);
      }
    }
  });
});

describe('内容规范：不下诊断结论', () => {
  /**
   * 这些是"下诊断"的典型句式。知识库里的文字会被当作依据引用给患者，
   * 出现"你就是 XX 病"等于系统在给诊断。
   */
  const DIAGNOSIS_PATTERNS = [
    /你(这)?(是|得了|患了|属于)[^，。]{0,6}(病|炎|癌|瘤|感染|障碍|综合征)/,
    /确诊为/,
    /可以确定(是|为)/,
  ];

  it('没有条目直接下诊断结论', () => {
    for (const d of KB_DOCS) {
      for (const p of DIAGNOSIS_PATTERNS) {
        expect(p.test(d.content), `${d.docId} 疑似下诊断：「${d.content.match(p)?.[0] ?? ''}」`).toBe(
          false,
        );
      }
    }
  });
});

describe('内容规范：涉及用药必须指向医生', () => {
  /** 提到具体药名或剂量的条目，必须同时出现"医生/遵医嘱/不要自行" */
  const DRUG = /(抗生素|布洛芬|阿司匹林|头孢|阿莫西林|奥美拉唑|二甲双胍|保肝药|助眠药|退热药|降压药)/;
  const GUARD = /(医生|遵医嘱|不要自行|面诊|须由|由医生)/;

  it('提到用药的条目都带了"由医生判断"', () => {
    for (const d of KB_DOCS) {
      if (!DRUG.test(d.content)) continue;
      expect(GUARD.test(d.content), `${d.docId} 提到用药但没有指向医生`).toBe(true);
    }
  });

  it('没有给出具体剂量', () => {
    // 剂量是最危险的内容：个体差异极大，写错可致命
    const DOSE = /\d+\s*(mg|毫克|g|克|ml|毫升|片|粒)[^。]{0,6}(每次|每日|一天|一日)/;
    for (const d of KB_DOCS) {
      expect(DOSE.test(d.content), `${d.docId} 出现了具体剂量`).toBe(false);
    }
  });
});

describe('内容规范：给可执行的下一步', () => {
  it('每条都提到了就诊去向或应对动作', () => {
    const ACTION = /(就诊|就医|复查|挂号|记录|补充|携带|带上|拨打|观察|避免|不要自行)/;
    for (const d of KB_DOCS) {
      expect(ACTION.test(d.content), `${d.docId} 没有可执行的下一步`).toBe(true);
    }
  });

  it('危险信号类条目给出了急诊指引', () => {
    const CRITICAL = KB_DOCS.filter((d) => /(急诊|立即拨打|120)/.test(d.content));
    expect(CRITICAL.length).toBeGreaterThan(0);
  });
});
