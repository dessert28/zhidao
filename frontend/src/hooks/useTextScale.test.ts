/* ------------------------------------------------------------------
 * 适老模式的测试
 *
 * 这个功能"看起来"很难测（要改 DOM 的 font-size、要读 localStorage），
 * 但它恰恰是最该测的：一个人设了"特大"，下次打开变回"标准"，
 * 他不会来报 bug，他会直接不用了。这种静默失效只能靠测试兜住。
 *
 * 断言从"行内 font-size"改成 data-scale：字号数值现在写在 index.css 里，
 * 由 html[data-scale=…] 规则提供，jsdom 不会计算样式表，
 * 断言属性是这个架构下最稳的验证点。
 * ------------------------------------------------------------------ */

import { beforeEach, describe, expect, it } from 'vitest';
import { applyTextScale, TEXT_SCALE_OPTIONS } from './useTextScale';

describe('applyTextScale', () => {
  beforeEach(() => {
    delete document.documentElement.dataset.scale;
  });

  it('标准档不挂 data-scale（默认态在 DOM 上可见）', () => {
    applyTextScale('normal');
    expect(document.documentElement.dataset.scale).toBeUndefined();
  });

  it('特大档挂上 xlarge', () => {
    applyTextScale('xlarge');
    expect(document.documentElement.dataset.scale).toBe('xlarge');
  });

  it('从特大切回标准会清掉属性', () => {
    applyTextScale('xlarge');
    applyTextScale('normal');
    expect(document.documentElement.dataset.scale).toBeUndefined();
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

  it('档位值与 index.css 的 data-scale 取值对齐', () => {
    /*
     * 这条是"两处值必须一致"的守卫：
     * applyTextScale 写的是 dataset.scale = o.value，
     * 而 index.css 里只认 data-scale='large' / 'xlarge'。
     * 谁改了枚举值却没改样式，界面就再也不缩放了 —— 而且是静默的。
     */
    expect(TEXT_SCALE_OPTIONS.map((o) => o.value)).toEqual(['normal', 'large', 'xlarge']);
  });
});
