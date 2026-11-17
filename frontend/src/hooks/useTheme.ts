/* ------------------------------------------------------------------
 * 深色模式
 *
 * ============ 为什么是"三态"而不是一个开关 ============
 *
 * 只存"亮/暗"的话，第一次访问的人必须被替我们做决定：
 * 手机系统明明是深色，页面却先亮一遍 —— 而这恰好是夜里最难受的一刻。
 * 所以默认值必须是 system（跟随系统），但用户要能显式钉死某一档。
 *
 * UI 上不把三态摊在顶栏（顶栏已经挤了 7 个导航 + 3 个字号按钮 +
 * 齿轮）：顶栏只放一个太阳/月亮，点一下在亮暗之间切换；
 * 三选一放在设置页，需要的人找得到，不需要的人看不见。
 *
 * ============ 首帧在 index.html ============
 *
 * 这里的 applyTheme 只负责"运行中切换"。首帧由 index.html 的内联脚本
 * 提前把 .dark 打好 —— 否则深色下会白闪一帧，而那正是最刺眼的时刻。
 * 两处读的是同一个 key，改一处必须改另一处。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'zhidao:theme';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* 隐私模式读不到就用默认 */
  }
  return 'system';
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * 演示/截图用的 URL 覆盖：?theme=light / ?theme=dark。
 *
 * <p>必须在这里也认一次 —— index.html 的内联脚本只决定首帧，
 * 挂载后 useTheme 会按系统偏好重算，把强制值覆盖掉，
 * 结果就是"链接里写了 light、页面还是深色"，而且会闪一下。
 * 两处读的是同一个参数，这属于同一件事必须只有一个定义。
 */
function forcedTheme(): ResolvedTheme | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('theme');
  return v === 'dark' ? 'dark' : v === 'light' ? 'light' : null;
}

/** 档位 → 实际生效的主题 */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  const forced = forcedTheme();
  if (forced) return forced;
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

/** 把主题打到 <html> 上。class 驱动 Tailwind 的 darkMode: 'class' */
export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  // 让原生控件（select / input / 滚动条）跟着换，否则深色页面上
  // 会出现一块白底下拉框 —— 看着像 bug
  root.style.colorScheme = resolved;
}

export function useTheme(): {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (m: ThemeMode) => void;
  /** 顶栏那个按钮用：在亮暗之间直接切换，跳过 system */
  toggle: () => void;
} {
  const [mode, setModeState] = useState<ThemeMode>(() => readStored());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readStored()));

  // 跟随系统时，系统切换要实时反映（桌面端日落自动变暗就靠这条）
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      if (mode !== 'system') return;
      const next = resolveTheme(mode);
      setResolved(next);
      applyTheme(next);
    };
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, [mode]);

  // 多标签页同步：在设置页改了主题，问诊页那个标签也该跟着变
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = readStored();
      setModeState(next);
      const r = resolveTheme(next);
      setResolved(r);
      applyTheme(r);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    const r = resolveTheme(m);
    setResolved(r);
    applyTheme(r);
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* 存不了就只在本次生效，不打扰用户 */
    }
  }, []);

  const toggle = useCallback(() => {
    // 跟随系统时，第一次点击要落在"与当前相反"的那一档 ——
    // 否则点了没反应，用户以为按钮坏了
    setMode(resolveTheme(mode) === 'dark' ? 'light' : 'dark');
  }, [mode, setMode]);

  return { mode, resolved, setMode, toggle };
}

/** 设置页三选一用的文案 */
export const THEME_OPTIONS: { value: ThemeMode; label: string; hint: string }[] = [
  { value: 'system', label: '跟随系统', hint: '手机或电脑切到深色时自动跟着变' },
  { value: 'light', label: '浅色', hint: '始终使用浅色，白天在户外更清楚' },
  { value: 'dark', label: '深色', hint: '夜里看更不刺眼' },
];
