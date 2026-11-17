/* ------------------------------------------------------------------
 * 适老模式 —— 字号与行距一键切换
 *
 * ============ 为什么这件事优先级比看起来高 ============
 *
 * docs/12 曾把这条标成 ❌ 未排期，但它其实是**用户结构决定的**：
 * 这个系统服务的核心人群是慢性病与老年患者，他们的共同特征是
 * 看不清 14px 的灰字、点不准 32px 的按钮。
 *
 * 一个 70 岁的高血压患者要在一堆小字里找到"今天 20:30 吃二甲双胍"，
 * 字号就是可用性本身。这不是"无障碍加分项"，是主路径。
 *
 * ============ 实现方式：改根元素的字号 ============
 *
 * Tailwind 的 text-sm / text-xs 全部是 rem 单位，所以
 * **只改 <html> 的 font-size 就能等比放大整个界面**，不用给每个
 * 组件写两套类名。这是这套方案能在一小时内落地而不是改一周的原因。
 *
 * 行距一并放大：只放字号不放行距，中文会挤在一起反而更难读。
 *
 * ============ 偏好存哪 ============
 *
 * localStorage 而不是 sessionStorage：视力需求不随"关掉标签页"改变。
 * 老人家下次打开浏览器，不该再去找一遍开关。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'zhidao:text-scale';

/** 三档：标准 / 大 / 特大。不做连续滑块 —— 三个按钮一眼能选，滑块要看半天 */
export type TextScale = 'normal' | 'large' | 'xlarge';

const SCALES: Record<TextScale, { root: string; lineHeight: string; label: string }> = {
  normal: { root: '100%', lineHeight: '1.5', label: '标准' },
  // 115%：大约 14px → 16px，是"看得出来但没变样"的第一档
  large: { root: '115%', lineHeight: '1.65', label: '大' },
  // 132%：接近系统"超大字体"，正文接近 18.5px
  xlarge: { root: '132%', lineHeight: '1.8', label: '特大' },
};

function readStored(): TextScale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'large' || v === 'xlarge' || v === 'normal') return v;
  } catch {
    /* 隐私模式读不到就用默认 */
  }
  return 'normal';
}

/** 把档位应用到 <html>。放独立函数，方便在首屏渲染前调用一次 */
export function applyTextScale(scale: TextScale): void {
  const root = document.documentElement;
  root.style.fontSize = SCALES[scale].root;
  root.style.lineHeight = SCALES[scale].lineHeight;
}

export function useTextScale(): {
  scale: TextScale;
  setScale: (s: TextScale) => void;
} {
  const [scale, setScaleState] = useState<TextScale>(() => readStored());

  // 首次挂载时应用一次（也覆盖了"上次设成特大，这次打开"的情况）
  useEffect(() => {
    applyTextScale(scale);
  }, [scale]);

  const setScale = useCallback((s: TextScale) => {
    setScaleState(s);
    try {
      localStorage.setItem(STORAGE_KEY, s);
    } catch {
      /* 存不了就只在本次生效，不打扰用户 */
    }
  }, []);

  return { scale, setScale };
}

/** 档位元数据，给 UI 渲染按钮用 */
export const TEXT_SCALE_OPTIONS = (Object.keys(SCALES) as TextScale[]).map((k) => ({
  value: k,
  label: SCALES[k].label,
}));
