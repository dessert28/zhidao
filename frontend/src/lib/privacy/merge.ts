/* ------------------------------------------------------------------
 * 规则结果 + 模型结果的合并
 *
 * 为什么要单独一个纯函数（而不是塞进 redact 或 ner）：
 *   **这是唯一能可靠单测的部分**。模型本身要下 129MB 权重、要 WebGPU，
 *   在 CI 里跑不了；但"两个结果集怎么合并"的逻辑出错会直接导致遮蔽错位，
 *   比模型精度问题严重得多。
 *
 * 合并规则（三条，都有具体理由）：
 *
 *   1. **区间重叠时保留规则结果。**
 *      规则命中的是确定形状（18 位身份证正则），模型命中的是概率。
 *      让概率覆盖确定性，等于用猜测替换事实。
 *
 *   2. **模型结果只增不删。**
 *      模型多标一个词，用户最多看到多一处高亮；
 *      模型少标一个，信息就发出去了。所以宁可多标。
 *
 *   3. **合并后必须重新排序。**
 *      调用方（Highlighted）按 start 升序切原文，
 *      乱序会让切片位置错位 —— 这个 bug 在生产上表现为
 *      "遮掉的不是那几个字"，极难发现。
 * ------------------------------------------------------------------ */

import type { PiiType } from './redact';

/** 一次遮蔽动作：谁在原文的哪一段被替换成什么 */
export interface RedactionHitLike {
  type: PiiType;
  start: number;
  end: number;
  placeholder: string;
}

/** 模型给出的实体（没有 placeholder，由合并时生成） */
export interface ModelEntityLike {
  type: PiiType;
  start: number;
  end: number;
  text: string;
}

/** 模型实体的占位符。和规则引擎的写法保持一致，UI 上一眼能看出是同一种遮蔽 */
const MODEL_PLACEHOLDER: Record<PiiType, string> = {
  address: '［住址已遮蔽］',
  phone: '［手机号已遮蔽］',
  id_card: '［证件号已遮蔽］',
  email: '［邮箱已遮蔽］',
  bank_card: '［银行卡已遮蔽］',
  medical_record_no: '［病历号已遮蔽］',
};

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && a.end > b.start;
}

/**
 * 合并规则命中和模型命中。
 *
 * @param ruleHits 规则引擎的结果（可信）
 * @param modelHits 模型结果，null 表示模型不可用
 * @returns 按 start 升序、互不重叠的最终遮蔽列表
 */
export function mergeHits(
  ruleHits: readonly RedactionHitLike[],
  modelHits: readonly ModelEntityLike[] | null,
): RedactionHitLike[] {
  // 规则结果先按位置排序（redact 内部已经排过，这里防御性再排一次）
  const merged: RedactionHitLike[] = [...ruleHits].sort((a, b) => a.start - b.start);

  if (!modelHits || modelHits.length === 0) {
    return merged;
  }

  for (const m of modelHits) {
    // 区间非法直接丢弃：模型偶尔会吐出负下标或倒序区间
    if (!(m.end > m.start) || m.start < 0) continue;

    // 规则 1：与任何已有遮蔽重叠就跳过（保留规则结果）
    if (merged.some((h) => overlaps(h, m))) continue;

    // 规则 2：模型多标的照收 —— 隐私场景宁可多遮
    merged.push({
      type: m.type,
      start: m.start,
      end: m.end,
      placeholder: MODEL_PLACEHOLDER[m.type],
    });
  }

  // 规则 3：必须重排，否则调用方切原文会错位
  return merged.sort((a, b) => a.start - b.start);
}

/**
 * 按遮蔽列表重建文本。
 *
 * <p>用它替换原来的"倒序 slice 拼接"：两者结果一样，
 * 但这个函数是纯的、可测的，而且显式表达"从游标往后拼"的意图。
 * 倒序拼接的写法一旦有人改成顺序遍历就立刻错位，而没有任何测试会先报错。
 */
export function applyHits(raw: string, hits: readonly RedactionHitLike[]): string {
  if (hits.length === 0) return raw;

  let out = '';
  let cursor = 0;
  for (const h of hits) {
    if (h.start < cursor) continue; // 防御：重叠区间跳过，绝不回头
    out += raw.slice(cursor, h.start) + h.placeholder;
    cursor = h.end;
  }
  return out + raw.slice(cursor);
}
