import { describe, expect, it } from 'vitest';
import { findTerms, GLOSSARY, type TermHit } from './glossary';

const names = (hits: TermHit[]) => hits.map((h) => h.term);

describe('findTerms 区间去重', () => {
  it('「磨玻璃结节」只注解磨玻璃，不再重复注解结节', () => {
    expect(names(findTerms('左肺上叶磨玻璃结节，直径约 4mm'))).toEqual(['磨玻璃密度影']);
  });

  it('「部分实性结节」优先于实性结节与结节', () => {
    expect(names(findTerms('右肺下叶部分实性结节'))).toEqual(['部分实性结节']);
  });

  it('「淋巴结转移」与前面单独出现的「淋巴结」各自保留一次', () => {
    // 两个词在原文里不在同一处，语义也不同（一个解释结构、一个解释结论），不该互相吞掉
    expect(names(findTerms('送检淋巴结 3 枚，其中 1 枚见淋巴结转移'))).toEqual([
      '淋巴结',
      '淋巴结转移',
    ]);
  });

  it('相邻但不重叠的两个术语都要保留', () => {
    const hits = findTerms('双肺见斑片影及条索影');
    expect(names(hits)).toEqual(['斑片影', '条索影']);
  });
});

describe('findTerms 排序与边界', () => {
  it('按首次出现位置排序', () => {
    const hits = findTerms('窦性心律，双肺纹理清晰，见结节');
    expect(names(hits)).toEqual(['窦性心律', '肺纹理', '结节']);
  });

  it('正常表述不硬凑注解', () => {
    expect(findTerms('双肺未见明显异常，心影大小正常')).toEqual([]);
  });

  it('空文本返回空数组', () => {
    expect(findTerms('')).toEqual([]);
    expect(findTerms('   ')).toEqual([]);
  });
});

describe('词库措辞的硬约束', () => {
  /*
   * 这条测试是给未来加词的人看的：解释里一旦出现判断性措辞，
   * 界面就从「解释术语」变成了「给结论」，越过医疗合规边界。
   */
  const JUDGEMENT = /要紧|严重|危险|紧急|必须|建议|应该|可能是|需要治疗|不要紧|没问题|影响不大/;

  it('每条解释都不含判断性措辞', () => {
    const bad = GLOSSARY.filter((e) => JUDGEMENT.test(e.explanation)).map((e) => e.term);
    expect(bad).toEqual([]);
  });

  it('每条解释都是一句话，长度在合理区间', () => {
    const bad = GLOSSARY.filter((e) => e.explanation.length < 8 || e.explanation.length > 60).map(
      (e) => `${e.term}:${e.explanation.length}`,
    );
    expect(bad).toEqual([]);
  });

  it('术语名不重复（重复会导致同一行出现两条注解）', () => {
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const e of GLOSSARY) {
      if (seen.has(e.term)) dup.push(e.term);
      seen.add(e.term);
    }
    expect(dup).toEqual([]);
  });

  it('每条 pattern 都能匹配到自己的 term（防止正则写错导致永不命中）', () => {
    const bad = GLOSSARY.filter((e) => !e.pattern.test(e.term)).map((e) => e.term);
    expect(bad).toEqual([]);
  });
});
