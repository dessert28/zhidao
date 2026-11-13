/* ------------------------------------------------------------------
 * 脱敏规则的测试 —— 这是整个隐私承诺的地基，必须严
 *
 * 测试策略：
 *   1. 每类 PII 都要有"能抓到"的用例
 *   2. 每类都要有"不误伤"的反例（医疗文本里数字很多）
 *   3. 要验证**顺序**正确（身份证不能被手机号规则切碎）
 *   4. 要验证**不泄漏**（hits 里不能出现原文）
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { hasPii, redact, summarizeHits } from './redact';

describe('身份证号', () => {
  it('18 位身份证被遮蔽，保留首尾各 4 位', () => {
    const r = redact('身份证 110101199003071234 请核对');
    expect(r.text).not.toContain('110101199003071234');
    expect(r.text).toContain('1101');
    expect(r.text).toContain('1234');
    expect(r.hits[0]?.type).toBe('id_card');
  });

  it('末位 X 也能识别', () => {
    const r = redact('11010119900307123X');
    expect(r.hits).toHaveLength(1);
  });

  it('身份证优先于手机号匹配（不能被切碎）', () => {
    const r = redact('110101199003071234');
    // 只应命中一条，不应同时命中 phone
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]?.type).toBe('id_card');
  });
});

describe('手机号', () => {
  it('11 位手机号被遮蔽', () => {
    const r = redact('我的电话 13812345678');
    expect(r.text).not.toContain('13812345678');
    expect(r.text).toContain('138****5678');
  });

  it('不是 1[3-9] 开头的 11 位数字不误伤', () => {
    // 以 2 开头，不是手机号
    const r = redact('编号 20123456789');
    expect(r.hits.some((h) => h.type === 'phone')).toBe(false);
  });
});

describe('姓名', () => {
  it('「我叫张三」只遮蔽姓名，保留标签', () => {
    const r = redact('我叫张三，今年45岁');
    expect(r.text).toContain('我叫');
    expect(r.text).not.toContain('张三');
    expect(r.text).toContain('［患者姓名］');
  });

  it('「患者：李四五」能识别', () => {
    const r = redact('患者：李四五 主诉头痛');
    expect(r.text).not.toContain('李四五');
  });

  it('不是姓氏的字不误伤', () => {
    const r = redact('我叫不上来哪里疼');
    expect(r.text).toContain('我叫不上来');
  });

  it('三字姓名能完整遮蔽，不残留末字', () => {
    const r = redact('我叫王小明');
    expect(r.text).not.toContain('王');
    expect(r.text).not.toContain('小明');
  });
});

describe('住址', () => {
  it('市区路号被遮蔽', () => {
    const r = redact('住北京市朝阳区建国路88号');
    expect(r.text).not.toContain('建国路88号');
    expect(r.text).toContain('住址已遮蔽');
  });
});

describe('邮箱与银行卡', () => {
  it('邮箱保留前两位', () => {
    const r = redact('邮箱 zhangsan@example.com');
    expect(r.text).toContain('zh***@example.com');
  });

  it('16 位银行卡被遮蔽', () => {
    const r = redact('卡号 6222021234567890');
    expect(r.hits.some((h) => h.type === 'bank_card')).toBe(true);
  });
});

describe('病历号', () => {
  it('带标签的病历号被遮蔽', () => {
    const r = redact('病历号：A1234567 复诊');
    expect(r.text).not.toContain('A1234567');
    expect(r.text).toContain('病历号：');
  });
});

describe('不误伤医疗文本', () => {
  const medicalTexts = [
    '血压 140/90，心率 78',
    '空腹血糖 7.2 mmol/L',
    '每天吃 1 片，一天三次',
    '三个月前做过胃镜',
    '左膝关节疼痛两周',
  ];

  it.each(medicalTexts)('「%s」不应被遮蔽', (t) => {
    expect(hasPii(t)).toBe(false);
  });
});

describe('组合场景', () => {
  it('一段话里的多种 PII 全部遮蔽', () => {
    const raw = '我叫张三，手机 13812345678，住北京市朝阳区建国路88号';
    const r = redact(raw);

    expect(r.text).not.toContain('张三');
    expect(r.text).not.toContain('13812345678');
    expect(r.text).not.toContain('建国路88号');
    expect(r.hits.length).toBeGreaterThanOrEqual(3);
  });

  it('倒序替换保证位置不漂移', () => {
    // 前一个遮蔽变短会导致后面位置错乱，这条专门验证
    const r = redact('手机13812345678，邮箱ab@cd.com');
    expect(r.text).toContain('138****5678');
    expect(r.text).toContain('ab***@cd.com');
  });
});

describe('安全性质：不得泄漏原文', () => {
  it('hits 里不含原文片段', () => {
    const r = redact('我叫张三，手机 13812345678');
    const dump = JSON.stringify(r.hits);
    expect(dump).not.toContain('张三');
    expect(dump).not.toContain('13812345678');
  });

  it('脱敏后文本长度合理（未发生坍缩）', () => {
    const raw = '我叫张三，手机 13812345678';
    const r = redact(raw);
    expect(r.originalLength).toBe(raw.length);
    expect(r.text.length).toBeGreaterThan(5);
  });
});

describe('摘要', () => {
  it('按类型计数', () => {
    const r = redact('张三 13812345678 13900001111');
    const s = summarizeHits(r.hits);
    expect(s).toContain('手机号 ×2');
  });

  it('无命中时给人话', () => {
    expect(summarizeHits([])).toContain('未检测到');
  });
});

describe('正则状态', () => {
  it('多次调用结果一致（g 标志的 lastIndex 已重置）', () => {
    const a = redact('13812345678');
    const b = redact('13812345678');
    expect(a.hits.length).toBe(b.hits.length);
    expect(a.text).toBe(b.text);
  });
});
