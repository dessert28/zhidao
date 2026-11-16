/* ------------------------------------------------------------------
 * useRedaction —— 输入框里这段文字的「最终去向」
 *
 * 为什么要有这个钩子：
 *   屏蔽规则、模型结果、合并、重建文本，这四步原来散落在 RedactionPreview 里。
 *   组件既负责显示又负责计算，后果是"发送"那条路只能另写一份 ——
 *   两份实现迟早不一致，而这次就是不一致：预览含模型命中，发送只有规则。
 *
 *   现在计算收在这里做一次，RedactionPreview 只显示，ChatPage 直接把
 *   同一个结果发出去。预览与实发不再是"两处代码碰巧写得一样"，
 *   而是同一个值。
 *
 * 与 outbound.ts 的分工：
 *   · 这里给「正在输入」用：随输入实时算，允许等模型（模型本来就在加载）
 *   · prepareOutbound 给「按下发送」用：模型没就绪就立刻返回，绝不让用户等
 * ------------------------------------------------------------------ */

import { useEffect, useMemo, useState } from 'react';
import { redact } from '../lib/privacy/redact';
import type { ModelEntityLike } from '../lib/privacy/merge';
import { composeOutbound } from '../lib/privacy/outbound';

/**
 * 本地模型对**这一段文本**的进度。
 *
 * <p>pending 与 done([]) 必须分开：前者是"还没结论"，
 * 后者是"检查过，确实没有"。混成一个 null 就会在模型还没跑完时
 * 告诉用户"未检测到个人信息" —— 那是错误的安全感。
 */
export type ModelPhase =
  | { phase: 'idle' }
  | { phase: 'pending' }
  | { phase: 'unavailable' }
  | { phase: 'done'; entities: ModelEntityLike[] };

export interface RedactionView {
  /** 脱敏后、可直接发送的文本 */
  text: string;
  /** 最终遮蔽列表（规则 + 模型） */
  hits: ReturnType<typeof composeOutbound>['hits'];
  modelUsed: boolean;
  model: ModelPhase;
}

export function useRedaction(raw: string): RedactionView {
  /** 规则结果同步出，输入即生效，不等模型 */
  const rule = useMemo(() => redact(raw), [raw]);

  /**
   * 模型结果连同"它是哪段文本算的"一起存。
   *
   * <p>只存结果会踩一个隐蔽的坑：用户改了字、新结果还没回来时，
   * 上一次的 start/end 仍指向**旧文本**的坐标，mergeHits 会照它去切新文本，
   * 表现是"遮掉的根本不是那几个字"。带一个 for 字段，位置就不会串。
   */
  const [computed, setComputed] = useState<{ for: string; phase: ModelPhase } | null>(null);

  useEffect(() => {
    if (!raw.trim()) {
      setComputed({ for: raw, phase: { phase: 'idle' } });
      return;
    }

    let cancelled = false;
    void (async () => {
      // 动态 import：transformers.js 有数 MB，不能进首屏包
      const { detectEntities } = await import('../lib/privacy/ner');
      const entities = await detectEntities(raw);
      if (cancelled) return;
      setComputed({
        for: raw,
        phase: entities ? { phase: 'done', entities } : { phase: 'unavailable' },
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [raw]);

  /** 结果必须是**为当前这段文本**算的，否则视为还在检查 */
  const model: ModelPhase =
    computed && computed.for === raw
      ? computed.phase
      : raw.trim()
        ? { phase: 'pending' }
        : { phase: 'idle' };

  const entities = model.phase === 'done' ? model.entities : null;

  const outbound = useMemo(() => composeOutbound(raw, rule.hits, entities), [raw, rule, entities]);

  return { ...outbound, model };
}
