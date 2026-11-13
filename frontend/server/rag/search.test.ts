/* ------------------------------------------------------------------
 * 检索层测试
 *
 * 重点验证的不是"能搜到"，而是：
 *   1. 切分正确（中文 bigram 不会切碎，英文数字不丢）
 *   2. 排序合理（明确相关的排在前面）
 *   3. 不相关查询不该硬凑（宁可空，不可乱给）
 *   4. 重复调用结果稳定（索引缓存不能有状态泄漏）
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { isEvidenceSufficient, KB_SIZE, search, tokenize } from './search';

describe('中文切分', () => {
  it('连续汉字切成 bigram', () => {
    expect(tokenize('空腹血糖')).toEqual(['空腹', '腹血', '血糖']);
  });

  it('单字保留单字', () => {
    expect(tokenize('痛')).toEqual(['痛']);
  });

  it('中英数字混合都能切出', () => {
    const t = tokenize('血糖 7.0 mmol');
    expect(t).toContain('血糖');
    expect(t).toContain('7');
    expect(t).toContain('mmol');
  });

  it('标点不产生 token', () => {
    const t = tokenize('头晕，恶心！');
    expect(t.every((x) => /[\u4e00-\u9fa5a-z0-9]/.test(x))).toBe(true);
  });
});

describe('检索召回', () => {
  it('「空腹血糖」召回血糖条目且排第一', () => {
    const hits = search('空腹血糖偏高');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.doc.docId).toBe('kb-001');
  });

  it('「血压高」召回血压条目', () => {
    const hits = search('血压有点高怎么办');
    expect(hits[0]?.doc.docId).toBe('kb-002');
  });

  it('「头晕」召回头晕条目', () => {
    const hits = search('最近老是头晕');
    expect(hits[0]?.doc.docId).toBe('kb-003');
  });

  it('「咳嗽」召回咳嗽条目', () => {
    const hits = search('咳嗽两周了');
    expect(hits[0]?.doc.docId).toBe('kb-008');
  });

  it('「重复检查」召回对应条目', () => {
    const hits = search('这个检查要重做吗');
    expect(hits.some((h) => h.doc.docId === 'kb-006')).toBe(true);
  });

  it('「过敏」召回过敏史条目', () => {
    const hits = search('青霉素过敏能不能用');
    expect(hits[0]?.doc.docId).toBe('kb-007');
  });
});

describe('不相关查询', () => {
  it('完全无关的输入返回空，不硬凑结果', () => {
    // 知识库里没有这个话题，应该诚实地返回空
    const hits = search('zzzz qqqq');
    expect(hits).toHaveLength(0);
  });

  it('空输入返回空', () => {
    expect(search('')).toHaveLength(0);
  });
});

describe('分数与可解释性', () => {
  it('分数归一化到 0–1', () => {
    const hits = search('血糖');
    for (const h of hits) {
      expect(h.score).toBeGreaterThanOrEqual(0);
      expect(h.score).toBeLessThanOrEqual(1);
    }
  });

  it('结果按分数降序', () => {
    const hits = search('血糖血压');
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it('每条结果带命中词，能解释为什么召回', () => {
    const hits = search('空腹血糖');
    expect(hits[0]?.matchedTerms.length).toBeGreaterThan(0);
  });

  it('limit 生效', () => {
    expect(search('血糖', 2).length).toBeLessThanOrEqual(2);
  });
});

describe('证据充分性', () => {
  it('≥2 篇才算充分', () => {
    const one = search('空腹血糖', 1);
    expect(isEvidenceSufficient(one)).toBe(false);
  });

  it('空结果不充分', () => {
    expect(isEvidenceSufficient([])).toBe(false);
  });

  it('多篇命中算充分', () => {
    const many = search('就诊准备材料', 5);
    if (many.length >= 2) {
      expect(isEvidenceSufficient(many)).toBe(true);
    }
  });
});

describe('稳定性', () => {
  it('同一查询多次调用结果一致（索引缓存无状态泄漏）', () => {
    const a = search('空腹血糖');
    const b = search('空腹血糖');
    expect(a.map((h) => h.doc.docId)).toEqual(b.map((h) => h.doc.docId));
    expect(a.map((h) => h.score)).toEqual(b.map((h) => h.score));
  });

  it('知识库非空且条目 id 唯一', () => {
    expect(KB_SIZE).toBeGreaterThanOrEqual(10);
    const hits = search('就诊');
    const ids = hits.map((h) => h.doc.docId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
