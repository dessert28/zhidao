import { describe, it, expect } from 'vitest';
import { needsHealthContext } from './context-relevance';

describe('needsHealthContext', () => {
  it('症状/用药类问题带档案', () => {
    expect(needsHealthContext('我最近头晕，血压是不是又高了')).toBe(true);
    expect(needsHealthContext('这个药能和降糖药一起吃吗')).toBe(true);
    expect(needsHealthContext('血糖 8.4 要不要紧')).toBe(true);
  });

  it('情绪主诉不带档案', () => {
    expect(needsHealthContext('我失恋了，很不舒服')).toBe(false);
    expect(needsHealthContext('最近压力好大')).toBe(false);
  });

  it('打招呼/感谢/重来不带档案', () => {
    expect(needsHealthContext('你好')).toBe(false);
    expect(needsHealthContext('谢谢！')).toBe(false);
    expect(needsHealthContext('重来')).toBe(false);
  });

  it('拿不准时保守带上', () => {
    expect(needsHealthContext('嗯')).toBe(true);
    expect(needsHealthContext('三天了')).toBe(true);
  });

  it('空文本不带', () => {
    expect(needsHealthContext('  ')).toBe(false);
  });
});
