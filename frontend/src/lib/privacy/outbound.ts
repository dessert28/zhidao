/* ------------------------------------------------------------------
 * 出站文本的唯一出口 —— 「预览看到什么，就发什么」
 *
 * 为什么需要这一层：
 *   原来脱敏有两份实现：预览一份（规则 + 模型合并后计数），
 *   发送一份（ChatPage 里直接调 redact()，只有规则）。
 *   于是模型标出的实体**显示在预览里、却原样发出去** ——
 *   不是漏了功能，是给了错误的安全感。这种 bug 比少遮一个词更糟：
 *   用户因此不再自己检查。
 *
 *   现在两条路都走 composeOutbound()，结构上不可能再分叉。
 *   「预览准不准」于是变成一个可测的事实，而不是靠人盯着两处代码。
 * ------------------------------------------------------------------ */

import { redact, type RedactionHit } from './redact';
import { applyHits, mergeHits, type ModelEntityLike, type RedactionHitLike } from './merge';

export interface Outbound {
  /** 真正写进请求体的文本 */
  text: string;
  /** 最终遮蔽列表（规则 + 模型），按 start 升序、互不重叠 */
  hits: RedactionHitLike[];
  /**
   * 本地模型是否参与了这次判定。
   *
   * <p>false 不代表"没检查"——规则一定检查过了；它表示**只**做了规则遮蔽。
   * UI 必须把这件事说出来，不能落成一句含糊的"已检查"。
   */
  modelUsed: boolean;
}

/**
 * 纯函数：把两路结果合成出站文本。
 *
 * <p>所有发送路径都必须经过它 —— 包括示例按钮（那条路径不经过输入框，
 * 没有已经算好的结果可用）。它没有 IO、没有 await，所以能直接单测，
 * 也就能把"发送的到底是哪一段"钉死在一行断言里。
 */
export function composeOutbound(
  raw: string,
  ruleHits: readonly RedactionHit[],
  modelHits: readonly ModelEntityLike[] | null,
): Outbound {
  const hits = mergeHits(ruleHits, modelHits);
  return {
    text: applyHits(raw, hits),
    hits,
    modelUsed: modelHits !== null,
  };
}

/**
 * 发送前的一次性计算。
 *
 * <p><b>只在模型已经就绪时才等它。</b>权重 129MB，如果这里 await 一个
 * 正在下载的 pipeline，用户点发送后会卡几分钟 —— 那是拿一个隐私缺陷
 * 换一个可用性缺陷，不划算。未就绪时立刻返回规则结果，
 * 并明确标记 {@code modelUsed: false}，由 UI 说明这一轮的边界。
 *
 * <p>这也是它不用 {@code detectWithModel} 的原因：那个会触发下载。
 */
export async function prepareOutbound(raw: string): Promise<Outbound> {
  const rule = redact(raw);

  const ner = await import('./ner');
  if (ner.getModelState().status !== 'ready') {
    return composeOutbound(raw, rule.hits, null);
  }

  const entities = await ner.detectEntities(raw);
  return composeOutbound(raw, rule.hits, entities);
}
