/* ------------------------------------------------------------------
 * 出站上下文 —— 档案、记忆这类"随问题一起发出去"的附属文本
 *
 * 为什么要有这一层：
 *   原来只有用户输入框里的那段走了脱敏，健康档案（年龄、慢病、过敏、
 *   在用药）是前端自己拼好后**直接**塞进请求体的：
 *
 *     text: opts.context ? `${opts.context}\n\n${opts.text}` : opts.text
 *
 *   内容上确实来自后端、看起来"已经是我们自己的数据"，但**那句话原本
 *   从没经过脱敏**。一旦档案里出现随访电话、外院病历号这类字段
 *   （后端一改就可能带上），它就会绕过整条隐私链路直接发给模型。
 *
 *   隐私边界不该取决于"当前那个字段里恰好没有 PII"。
 *   所以上下文和问题走同一个 composeOutbound —— 两道关，一个出口。
 * ------------------------------------------------------------------ */

import { prepareOutbound } from './outbound';

/**
 * 拼出真正要发出去的请求体文本。
 *
 * <p>上下文与问题分别脱敏再拼接，而不是拼完再脱敏：
 * 分开之后，某一半是空的、或者只发上下文时，遮蔽位置不会互相串。
 *
 * <p>顺序（上下文在前）与原来保持一致 —— 模型读到的是
 * "我的健康档案……\n\n我的问题……"，改顺序会影响回答质量。
 */
export async function composeRequestText(
  context: string,
  question: string,
): Promise<{ text: string; contextMasked: boolean; maskedHits: number }> {
  const ctx = await prepareOutbound(context);
  const q = await prepareOutbound(question);

  const ctxText = ctx.text.trim();
  const qText = q.text.trim();
  // 两边都可能为空（示例按钮只给问题、只发档案不给问题）。
  // 空字符串也 truthy 的判断会让请求体以两个换行结尾，那是一个空问题。
  const parts = [ctxText, qText].filter((s) => s.length > 0);

  return {
    text: parts.join('\n\n'),
    /** 上下文里是否真的遮掉了东西 —— 用于在界面上如实说明"连档案也过了一遍" */
    contextMasked: context.trim() !== ctxText,
    maskedHits: ctx.hits.length + q.hits.length,
  };
}
