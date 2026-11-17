/* ------------------------------------------------------------------
 * 界面偏好（字号 + 主题）的共享状态
 *
 * ============ 为什么需要这一层 ============
 *
 * 字号和主题原来是由 `useTextScale()` / `useTheme()` 各自在组件里调用。
 * 这两个 hook 内部都是 useState + localStorage —— 没挂监听时，
 * 每个调用点都是一份**独立的副本**：
 *   · 在「我的」页把主题改成深色，<html> 上的 .dark 会立刻生效，
 *     但顶栏那个太阳/月亮图标读的是 App 自己那份 state，不会变；
 *   · 字号同理：页面变大了，顶栏按钮上的"大/特大"字样还是旧的。
 *
 * 这类"界面已经变了、控件还停在过去"的状态很难被当成 bug 报出来，
 * 用户只会觉得这个开关"有点傻"。
 *
 * 所以把两个 hook 收进一个 Provider，App 与各页面读同一份状态。
 * 底层 hook 本身不动 —— 它们已经处理了首帧、跟随系统、多标签同步，
 * 那部分逻辑没有理由重写。
 * ------------------------------------------------------------------ */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTextScale, type TextScale } from './useTextScale';
import { useTheme, type ResolvedTheme, type ThemeMode } from './useTheme';

export interface UiPrefs {
  /** 当前字号档位 */
  scale: TextScale;
  setScale: (s: TextScale) => void;
  /** 主题：存的是三态（含"跟随系统"） */
  themeMode: ThemeMode;
  setThemeMode: (m: ThemeMode) => void;
  /** 三态解析后真正生效的值 */
  resolvedTheme: ResolvedTheme;
  /** 顶栏那颗按钮用：在亮暗之间直接切，跳过 system */
  toggleTheme: () => void;
}

const Ctx = createContext<UiPrefs | null>(null);

export function UiPrefsProvider({ children }: { children: ReactNode }) {
  const { scale, setScale } = useTextScale();
  const { mode, resolved, setMode, toggle } = useTheme();

  /*
   * useMemo 不是必需的（Provider 只在 App 顶层渲染一次），
   * 但少了它每次 App 重渲染都会给所有消费组件一个新对象，
   * 组件里的 useMemo/依赖数组会全部失效。
   */
  const value = useMemo<UiPrefs>(
    () => ({
      scale,
      setScale,
      themeMode: mode,
      setThemeMode: setMode,
      resolvedTheme: resolved,
      toggleTheme: toggle,
    }),
    [scale, setScale, mode, setMode, resolved, toggle],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUiPrefs(): UiPrefs {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUiPrefs 必须在 <UiPrefsProvider> 内部使用');
  return v;
}
