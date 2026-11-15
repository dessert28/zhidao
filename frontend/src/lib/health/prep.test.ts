import { describe, expect, it } from 'vitest';
import {
  buildPrepList,
  departmentNeedsFasting,
  sortPrepItems,
  summarizePrep,
} from './prep';
import type { MedicalRecord } from '../api';

const rec = (id: number): MedicalRecord => ({
  id,
  hospitalCode: 'MOCK-A',
  visitDate: '2026-09-12',
  department: '内分泌科',
  diagnosisBrief: '',
  ocrText: '',
  fileName: null,
  source: 'UPLOAD',
});

describe('空腹判断', () => {
  it('内分泌科默认需要空腹', () => {
    expect(departmentNeedsFasting('内分泌科')).toBe(true);
  });

  it('骨科不需要空腹', () => {
    expect(departmentNeedsFasting('骨科')).toBe(false);
  });

  it('文本里提到血脂/肝功能也算', () => {
    expect(departmentNeedsFasting('全科医学科', '开一个血脂检查')).toBe(true);
  });

  it('血常规不算空腹 —— 不能让人白饿一早上', () => {
    expect(departmentNeedsFasting('全科医学科', '查个血常规')).toBe(false);
  });
});

describe('准备清单', () => {
  it('内分泌科 → 有空腹提醒', () => {
    const items = buildPrepList({ department: '内分泌科' });
    expect(items.some((i) => i.title.includes('空腹'))).toBe(true);
  });

  it('骨科 → 不出现空腹提醒', () => {
    const items = buildPrepList({ department: '骨科' });
    expect(items.some((i) => i.title.includes('空腹'))).toBe(false);
  });

  it('有既往病历时提醒带上', () => {
    const items = buildPrepList({ department: '骨科', records: [rec(1), rec(2)] });
    const r = items.find((i) => i.title.includes('既往检查报告'));
    expect(r).toBeDefined();
    expect(r!.title).toContain('2 份');
  });

  it('没有病历时不提醒带报告', () => {
    const items = buildPrepList({ department: '骨科', records: [] });
    expect(items.some((i) => i.title.includes('既往检查报告'))).toBe(false);
  });

  it('在服药时提醒带用药清单，且提醒问医生', () => {
    const items = buildPrepList({ department: '内分泌科', hasMedications: true });
    expect(items.some((i) => i.title.includes('用药清单'))).toBe(true);

    const ask = items.find((i) => i.title.includes('问医生'));
    expect(ask).toBeDefined();
    expect(ask!.level).toBe('ask');
  });

  it('停药问题必须写成「问医生」，不能给答案', () => {
    /*
     * 合规红线：停不停药取决于药物与检查项目，
     * 我们给不出正确答案，给错了比不给更糟。
     */
    const items = buildPrepList({ department: '内分泌科', hasMedications: true });
    const ask = items.find((i) => i.level === 'ask')!;

    expect(ask.detail).toContain('不要自己停药');
    // 不能出现"可以停/建议停/需要停"这类指导性表述
    expect(ask.detail).not.toMatch(/可以停|建议停|应当停|需要停药/);
  });

  it('糖尿病/高血压患者被提醒带自测记录', () => {
    const items = buildPrepList({
      department: '内分泌科',
      chronics: ['2型糖尿病'],
    });
    expect(items.some((i) => i.title.includes('自测记录'))).toBe(true);
  });

  it('没有慢病时不提自测记录', () => {
    const items = buildPrepList({ department: '骨科', chronics: [] });
    expect(items.some((i) => i.title.includes('自测记录'))).toBe(false);
  });

  it('每条都有 why —— 患者知道原因才愿意遵守', () => {
    const items = buildPrepList({
      department: '内分泌科',
      hasMedications: true,
      chronics: ['2型糖尿病'],
      records: [rec(1)],
    });
    for (const i of items) {
      expect(i.why.length, `${i.title} 缺原因`).toBeGreaterThan(8);
      expect(i.detail.length, `${i.title} 缺具体做法`).toBeGreaterThan(8);
    }
  });

  it('通用项始终存在（证件、报到）', () => {
    const items = buildPrepList({ department: '皮肤科' });
    expect(items.some((i) => i.title.includes('身份证'))).toBe(true);
    expect(items.some((i) => i.title.includes('报到'))).toBe(true);
  });
});

describe('排序与摘要', () => {
  it('must 排在最前', () => {
    const items = sortPrepItems(
      buildPrepList({ department: '内分泌科', hasMedications: true, records: [rec(1)] }),
    );
    expect(items[0]!.level).toBe('must');
    // 末尾不应是 must
    expect(items[items.length - 1]!.level).not.toBe('must');
  });

  it('摘要点名必须项', () => {
    const items = buildPrepList({ department: '内分泌科', needsFasting: true });
    expect(summarizePrep(items)).toContain('必须');
  });

  it('没有必须项时给中性描述', () => {
    expect(summarizePrep([])).toBe('按常规准备即可');
  });
});

describe('安全边界', () => {
  it('不给出任何具体的停药/服药指导', () => {
    const items = buildPrepList({
      department: '内分泌科',
      hasMedications: true,
      chronics: ['高血压'],
    });
    for (const i of items) {
      const text = `${i.title}${i.detail}${i.why}`;
      /*
       * 不能出现**指导性**的停药表述。
       *
       * 注意不能简单禁"停药"二字：我们的文案里有
       * 「不要自己停药」——那是必要的警告，正是我们要的。
       * 所以只禁"可以停 / 建议停 / 应当停"这类**肯定式**指导。
       * 第一版正则写成 /停药/ 就把这句正确警告也判成了违规，
       * 是测试过严，不是文案有问题。
       */
      expect(text).not.toMatch(/(可以|建议|应当|应该|需要)(停药|改量)|自行(停药|调量)/);
    }
  });

  it('明确出现「不要自己停药」这类必要警告', () => {
    const items = buildPrepList({ department: '内分泌科', hasMedications: true });
    const ask = items.find((i) => i.level === 'ask')!;
    expect(ask.detail).toContain('不要自己停药');
  });
});
