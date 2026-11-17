/* ------------------------------------------------------------------
 * 上传草稿抽取的测试
 *
 * 这里测的是「患者看到的草稿」：它必须来自脱敏文本、必须压缩空白、
 * 必须如实反映"抽到了什么/没抽到什么"。
 *
 * 不测医学准确性 —— 这是规则匹配，不是医学 NLP。
 * 测的是**边界是否诚实**：抽不到就返回空，而不是编一条给患者。
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { BRIEF_LIMIT, extractDraft } from './extract';

const RAW = `患者：张伟，身份证 110101199003071234，手机 13812345678。
主诉：血糖控制不佳三个月。
空腹血糖 8.4 mmol/L。`;

describe('extractDraft：摘要', () => {
  it('摘要来自脱敏文本，不带证件号与手机号', () => {
    const d = extractDraft(RAW);

    expect(d.diagnosisBrief).toContain('血糖');
    expect(d.diagnosisBrief, '身份证泄漏').not.toContain('110101199003071234');
    expect(d.diagnosisBrief, '手机号泄漏').not.toContain('13812345678');
  });

  it('换行与连续空白被压成单个空格', () => {
    const d = extractDraft('主诉：\n\n血糖\n控制不佳');
    expect(d.diagnosisBrief).toBe('主诉： 血糖 控制不佳');
    expect(d.diagnosisBrief).not.toContain('\n');
  });

  it('超长文本截到上限，不会把整份病历塞进摘要', () => {
    const d = extractDraft('糖'.repeat(500));
    expect(d.diagnosisBrief).toHaveLength(BRIEF_LIMIT);
  });

  it('空文本返回空摘要，不编造内容', () => {
    const d = extractDraft('   ');
    expect(d.diagnosisBrief).toBe('');
  });

  it('调用方传入已脱敏文本时直接复用，保证与提交文本同源', () => {
    const d = extractDraft('一段没被用到的原文', {
      redactedText: '主诉：复查血糖',
    });
    expect(d.diagnosisBrief).toBe('主诉：复查血糖');
  });
});

describe('extractDraft：检查项目', () => {
  it('检查单复用 parseExamOrder 的词典结果', () => {
    const d = extractDraft('检查项目：\n胸部 CT 平扫\n血常规', { kind: 'examOrder' });

    const names = d.examItems.map((i) => i.name);
    // 词典命中后返回标准名（原文保留在 evidence 里）——归一化对展示是有意的收窄
    expect(names).toContain('胸部CT');
    expect(names).toContain('血常规');

    // 归站正确：影像 → EXAM，抽血 → LAB
    expect(d.examItems.find((i) => i.name === '胸部CT')?.placeType).toBe('EXAM');
    expect(d.examItems.find((i) => i.name === '血常规')?.placeType).toBe('LAB');
  });

  it('既往病历不解析检查项目：化验结果是"发生过的事"，不是"要去做的事"', () => {
    const d = extractDraft('空腹血糖 8.4 mmol/L', { kind: 'record' });

    expect(d.examItems).toEqual([]);
    // 摘要照常抽：这次就诊的医疗内容仍然要展示
    expect(d.diagnosisBrief).toContain('血糖');
  });

  it('抽不到时返回空数组，不假装解析成功', () => {
    const d = extractDraft('遵医嘱复查，不适随诊', { kind: 'examOrder' });

    expect(d.examItems).toEqual([]);
    expect(d.diagnosisBrief).toContain('遵医嘱');
  });

  it('默认类型是 record，不需要调用方每次都传', () => {
    const d = extractDraft('血常规');
    expect(d.kind).toBe('record');
    expect(d.examItems).toEqual([]);
  });
});
