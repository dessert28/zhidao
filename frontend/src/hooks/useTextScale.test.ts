/* ------------------------------------------------------------------
 * 适老模式的测试
 *
 * 这个功能"看起来"很难测（要改 DOM 的 font-size、要读 localStorage），
 * 但它恰恰是最该测的：一个人设了"特大"，下次打开变回"标准"，
 * 他不会来报 bug，他会直接不用了。这种静默失效只能靠测试兜住。
 * ------------------------------------------------------------------ */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTextScale, TEXT_SCALE_OPTIONS } from './useTextScale';

describe('applyTextScale', () => {
  beforeEach(() => {
    document.documentElement.style.fontSize = '';
    document.documentElement.style.lineHeight = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('标准档把根字号设回 100%', () => {
    applyTextScale('normal');
    expect(document.documentElement.style.fontSize).toBe('100%');
  });

  it('特大档放大到 132%', () => {
    applyTextScale('xlarge');
    expect(document.documentElement.style.fontSize).toBe('132%');
  });

  it('字号与行距一起放大', () => {
    /*
     * 只放字号不放行距，中文会挤在一起反而更难读。
     * 这条断言防止有人"优化"掉行距那一行。
     */
    applyTextScale('normal');
    const normalLh = parseFloat(document.documentElement.style.lineHeight);

    applyTextScale('xlarge');
    const xlargeLh = parseFloat(document.documentElement.style.lineHeight);

    expect(xlargeLh).toBeGreaterThan(normalLh);
  });

  it('尺寸是递增的', () => {
    const seen: number[] = [];
    for (const o of TEXT_SCALE_OPTIONS) {
      applyTextScale(o.value);
      seen.push(parseFloat(document.documentElement.style.fontSize));
    }
    // 三档必须严格递增，否则"特大"却比"大"还小
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(3);
  });
});

describe('TEXT_SCALE_OPTIONS', () => {
  it('三档，标签都是中文短词', () => {
    expect(TEXT_SCALE_OPTIONS).toHaveLength(3);
    for (const o of TEXT_SCALE_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0);
      // 按钮很窄，标签超过 3 个字就会把顶栏挤变形
      expect(o.label.length).toBeLessThanOrEqual(3);
    }
  });
});
