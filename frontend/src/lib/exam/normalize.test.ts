/* ------------------------------------------------------------------
 * 检查项目归一测试
 *
 * 归一错了的后果比"认不出"严重得多：上层会据此提示
 * "你在两家医院被重复检查"，在医患语境里这是一种指控。
 * 所以这里两类用例同等重要：
 *   · 该合并的必须合并（语序、别名、全角半角、增强/平扫）
 *   · 无关文本必须返回 null，不能硬凑出一个「模态:部位」
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { normalizeExamName, normalizeRecordExams } from './normalize';

describe('影像：模态与部位分离', () => {
  it('「胸部CT平扫」「CT胸部平扫」「胸部计算机断层扫描」归一相同', () => {
    const keys = ['胸部CT平扫', 'CT胸部平扫', '胸部计算机断层扫描'].map((raw) =>
      normalizeExamName(raw),
    );
    // 三种语序/叫法必须落到同一个 key，否则跨院比对永远比不到一起
    expect(keys).toEqual(['CT:胸部', 'CT:胸部', 'CT:胸部']);
  });

  it('「腹部彩超」「腹部B超」归一相同', () => {
    expect(normalizeExamName('腹部彩超')).toBe('超声:腹部');
    expect(normalizeExamName('腹部B超')).toBe('超声:腹部');
  });

  it('增强与平扫归一到同一「模态 + 部位」', () => {
    // 取舍见 normalize.ts 文件头：提示关注"同一部位又查了一次"，
    // 增强与否交给医生判断，所以两者刻意合并
    expect(normalizeExamName('胸部增强CT')).toBe('CT:胸部');
    expect(normalizeExamName('胸部CT平扫')).toBe('CT:胸部');
  });

  it('全角、空格、括号不影响归一', () => {
    expect(normalizeExamName('胸部 ＣＴ（平扫）')).toBe('CT:胸部');
  });

  it('MRI 的常见叫法', () => {
    expect(normalizeExamName('头颅核磁共振')).toBe('MRI:头颅');
    expect(normalizeExamName('头颅MRI平扫')).toBe('MRI:头颅');
    expect(normalizeExamName('颅脑磁共振成像')).toBe('MRI:头颅');
  });

  it('X 线的常见叫法（胸片 / 正位片）', () => {
    expect(normalizeExamName('胸片')).toBe('X线:胸部');
    expect(normalizeExamName('胸部正位片')).toBe('X线:胸部');
  });

  it('心电图没有部位也能成立', () => {
    expect(normalizeExamName('心电图')).toBe('心电图:常规');
  });

  it('只有模态没有部位时返回 null，不编部位', () => {
    // "CT"单独出现无法知道查的是哪里，猜一个部位就是假阳性来源
    expect(normalizeExamName('CT')).toBeNull();
    expect(normalizeExamName('建议做增强CT')).toBeNull();
  });
});

describe('无关文本', () => {
  it('认不出就返回 null', () => {
    for (const raw of ['患者主诉头痛', '遵医嘱执行', '注意休息', '胸部不适', '', '   ']) {
      expect(normalizeExamName(raw)).toBeNull();
    }
  });
});

describe('normalizeRecordExams', () => {
  it('一条记录里多个项目各自归一，输出含 standardKey / name / raw', () => {
    const out = normalizeRecordExams('检查：胸部CT平扫；腹部彩超；糖化血红蛋白7.8%');
    expect(out.map((e) => e.standardKey)).toEqual([
      'CT:胸部',
      '超声:腹部',
      '检验:糖化血红蛋白',
    ]);

    const ct = out[0];
    expect(ct?.name).toBe('胸部CT');
    expect(ct?.modality).toBe('CT');
    expect(ct?.bodyPart).toBe('胸部');
    expect(ct?.raw).toContain('胸部');
  });

  it('同一段文本里同一种 key 只出一次', () => {
    const out = normalizeRecordExams('胸部CT平扫、CT胸部');
    expect(out).toHaveLength(1);
    expect(out[0]?.standardKey).toBe('CT:胸部');
  });

  it('换行是边界：上一行的部位不会配给下一行的模态', () => {
    /*
     * 检查单是"一行一项"。如果跨行配对，
     * "胸部"会和下一行的"心电图"凑成"胸部心电图"这种不存在的检查。
     */
    const out = normalizeRecordExams('肝胆胰脾\n心电图');
    const keys = out.map((e) => e.standardKey);
    expect(keys).toEqual(['心电图:常规']);
  });

  it('检验与影像同时出现时都能抽到', () => {
    const out = normalizeRecordExams('胸部CT、空腹血糖、糖化血红蛋白');
    const keys = new Set(out.map((e) => e.standardKey));
    expect(keys).toEqual(new Set(['CT:胸部', '检验:空腹血糖', '检验:糖化血红蛋白']));
  });
});
