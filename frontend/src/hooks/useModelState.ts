/* ------------------------------------------------------------------
 * useModelState —— 把端侧模型状态接进 React
 *
 * 为什么不写在 ner.ts 里：
 *   ner.ts 是纯逻辑，可以被 worker、测试、脚本引用；
 *   React 钩子必须依赖 react。混在一起会让"只想用 detectEntities"
 *   的地方被迫拖进 react 依赖链。
 *
 * 订阅方式用"动态 import 后订阅"而不是静态 import：
 *   RedactionPreview 是首屏组件，静态 import ner 会把
 *   transformers.js（数 MB）拉进主包 —— 这正是我们要避免的。
 * ------------------------------------------------------------------ */

import { useEffect, useState } from 'react';
import type { ModelState } from '../lib/privacy/ner';

/**
 * 订阅模型加载状态。
 *
 * <p>初始值用 {@code idle}，真实状态在动态 import 完成后同步一次。
 * 这个短暂的 idle 是安全的：预置的默认文案是"还没开始加载"，
 * 而不会错误地告诉用户"已就绪"。
 */
export function useModelState(): ModelState {
  const [state, setState] = useState<ModelState>({ status: 'idle' });

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;

    void import('../lib/privacy/ner').then((m) => {
      if (cancelled) return;
      // 先同步当前状态，避免错过 import 期间的变更
      setState(m.getModelState());
      unsub = m.onModelStateChange(setState);
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  return state;
}
