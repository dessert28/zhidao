import { describe, expect, it } from 'vitest';
import { sanitizeTerms, MAX_AI_TERMS } from './term-explainer';

const TEXT =
  '左肺上叶见磨玻璃结节，直径约 4mm。右侧胸膜局部增厚。' +
  '纵隔内见小淋巴结影。主动脉弓见点状钙化。肝内见小囊肿。' +
  '甲状腺右叶见低回声区，TI-RADS 3 类。';

describe('sanitizeTerms', () => {
  it('保留：原文出现、非判断性、长度合适的词', () => {
    const out = sanitizeTerms(
      { terms: [{ term: '磨玻璃结节', explanation: '影像上一小片淡淡的、像磨砂玻璃一样的影子。' }] },
      TEXT,
    );
    expect(out).toEqual([
      { term: '磨玻璃结节', explanation: '影像上一小片淡淡的、像磨砂玻璃一样的影子。' },
    ]);
  });

  it('丢弃带判断性措辞的解释（模型最爱在这里越界）', () => {
    const out = sanitizeTerms(
      {
        terms: [
          { term: '磨玻璃结节', explanation: '这个比较要紧，需要尽快治疗。' },
          { term: '钙化', explanation: '组织里出现了钙盐沉积，是很常见的现象。' },
        ],
      },
      TEXT,
    );
    expect(out.map((t) => t.term)).toEqual(['钙化']);
  });

  it('丢弃原文里没有的词（防止模型自己加戏）', () => {
    const out = sanitizeTerms(
      { terms: [{ term: '吸烟史', explanation: '指长期吸烟的情况，与多种疾病相关。' }] },
      TEXT,
    );
    expect(out).toEqual([]);
  });

  it('丢弃词库里已经解释过的词', () => {
    const out = sanitizeTerms(
      { terms: [{ term: '钙化', explanation: '组织里出现了钙盐沉积，表现为很亮的白点。' }] },
      TEXT,
      ['钙化'],
    );
    expect(out).toEqual([]);
  });

  it('丢弃过短或过长的解释', () => {
    const out = sanitizeTerms(
      {
        terms: [
          { term: '囊肿', explanation: '液体' },
          { term: '胸膜', explanation: '这'.repeat(80) },
        ],
      },
      TEXT,
    );
    expect(out).toEqual([]);
  });

  it(`最多保留 ${MAX_AI_TERMS} 条`, () => {
    // 原文里有 7 个可注解的词，必须截到 6 —— 否则注解区会变成一篇小作文
    const pool = ['磨玻璃结节', '胸膜', '淋巴结', '钙化', '囊肿', '低回声', 'TI-RADS'];
    const terms = pool.map((term) => ({
      term,
      explanation: `${term} 是报告里用来描述某种影像表现的说法。`,
    }));
    const out = sanitizeTerms({ terms }, TEXT);
    expect(out).toHaveLength(MAX_AI_TERMS);
  });

  it('同一术语只保留一条', () => {
    const out = sanitizeTerms(
      {
        terms: [
          { term: '囊肿', explanation: '一个里面有液体的囊状结构，边界通常比较清楚。' },
          { term: '囊肿', explanation: '另一个说法，但说的是同一个词，不该重复出现。' },
        ],
      },
      TEXT,
    );
    expect(out).toHaveLength(1);
  });

  it('模型返回结构不对时返回空数组而不是抛错', () => {
    expect(sanitizeTerms(null, TEXT)).toEqual([]);
    expect(sanitizeTerms({ terms: '钙化' }, TEXT)).toEqual([]);
    expect(sanitizeTerms({ terms: [{ term: 1 }] }, TEXT)).toEqual([]);
  });
});
