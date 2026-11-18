/* ------------------------------------------------------------------
 * 术语释义（模型补词） —— 只给词义，不给判断
 *
 * ============ 为什么模型只做这一件事 ============
 *
 * 内置词库（src/lib/health/glossary.ts）覆盖的是常见术语，
 * 但报告写法千变万化，总会有库里没有的词。这时候让模型补，
 * 比让患者自己去搜安全得多 —— 但前提是**把它的输出限制在词义上**。
 *
 * 所以这里的约束是双层的：
 *
 *   1. prompt 里明确禁止评价轻重、推测疾病、给治疗行为
 *   2. 拿到结果之后**再过一遍过滤器**（sanitizeTerms），
 *      出现「要紧 / 严重 / 可能是 / 建议 / 癌」这类字样整条丢弃
 *
 * 第二层不能省。提示词是请求，过滤器才是保证 ——
 * 模型偶尔不听话是常态，而这里的错话会被患者当成医嘱。
 *
 * ============ 为什么只列原文里出现过的词 ============
 *
 * 模型有"补充解释"的冲动，会给一段胸片报告附上「吸烟史」之类的
 * 词条 —— 那些词原文里根本没有，患者会以为报告里查出来了。
 * 所以 term 必须能在原文里原样找到，否则丢弃。
 * ------------------------------------------------------------------ */

import { z } from 'zod';
import { askObject, isLlmConfigured } from '../llm/client.js';
import { redact } from '../../src/lib/privacy/redact.js';

/** AI 补出来的一条术语 */
export interface AiTerm {
  term: string;
  explanation: string;
}

/** 判断性、建议性措辞。命中即丢弃整条 */
export const JUDGEMENT_RE =
  /要紧|严重|危险|紧急|立即|马上|必须|建议|应该|应当|可以考虑|可能是|可能为|考虑为|考虑是|提示|诊断为|确诊|治疗|手术|用药|服药|癌|恶性|良性|不要紧|没问题|无大碍|影响不大|不必|无需|预后|生存/;

/** 单条解释的长度区间（字）。太短没信息，太长就开始讲故事了 */
const MIN_EXPLANATION = 6;
const MAX_EXPLANATION = 60;

/** 一次最多补几条。给多了整块会变成一篇小作文 */
export const MAX_AI_TERMS = 6;

const SCHEMA = z.object({
  terms: z.array(
    z.object({
      term: z.string(),
      explanation: z.string(),
    }),
  ),
});

const SYSTEM = `你是医学词典的编辑，只做一件事：把检查报告里的专业术语解释成普通人能懂的字面含义。

硬性要求：
1. 只解释「这个词描述的是什么现象 / 是什么东西」，不评价轻重，不推测可能是哪种病，不说要不要治疗。
2. 每条解释 10 到 45 字，一句话。
3. 禁止出现这些词：要紧、严重、危险、建议、可能是、需要治疗、良性、恶性、癌。
4. 只列原文里真实出现过的词，不要补充原文没有的术语；最多 6 条。
5. 不要复述姓名、医院、日期、病历号等任何个人信息。
6. 如果原文里没有需要解释的专业术语，返回空数组。`;

/** 校验并清洗模型输出 */
export function sanitizeTerms(raw: unknown, text: string, known: string[] = []): AiTerm[] {
  const parsed = SCHEMA.safeParse(raw);
  if (!parsed.success) return [];

  const knownSet = new Set(known.map((k) => k.trim()).filter(Boolean));
  const seen = new Set<string>();
  const out: AiTerm[] = [];

  for (const item of parsed.data.terms) {
    const term = item.term.replace(/\s+/g, '').trim();
    const explanation = item.explanation.replace(/\s+/g, ' ').trim();

    // 原文里找不到 → 模型自己编的词条
    if (term.length < 2 || term.length > 14) continue;
    if (!text.includes(term)) continue;
    if (knownSet.has(term) || seen.has(term)) continue;
    if (explanation.length < MIN_EXPLANATION || explanation.length > MAX_EXPLANATION) continue;
    if (JUDGEMENT_RE.test(explanation)) continue;
    // 解释里又冒出别的判断字样时上面已挡；这里再兜一次个人信息
    if (redact(explanation).hits.length > 0) continue;

    seen.add(term);
    out.push({ term, explanation });
    if (out.length >= MAX_AI_TERMS) break;
  }

  return out;
}

export type ExplainResult =
  | { ok: true; terms: AiTerm[] }
  | { ok: false; reason: 'no_model' | 'failed' | 'bad_input'; message: string };

/**
 * 让模型补词。
 *
 * <p>失败一律返回结构化原因，不抛异常 —— 调用方（路由）会把
 * `ok:false` 直接变成界面上一句「当前用内置词库」，而不是报错。
 */
export async function explainTerms(args: {
  text: string;
  known: string[];
}): Promise<ExplainResult> {
  const text = (args.text ?? '').trim();
  if (!text) return { ok: false, reason: 'bad_input', message: '没有可解释的文本' };

  if (!isLlmConfigured()) {
    return { ok: false, reason: 'no_model', message: '未配置模型，当前只用内置词库' };
  }

  // 超长文本截断：报告结论通常一屏以内，截断点落在结论后半段也不影响术语识别
  const clipped = text.slice(0, 4000);

  const object = await askObject({
    schema: SCHEMA,
    system: SYSTEM,
    temperature: 0.1,
    prompt:
      `报告原文：\n${clipped}\n\n` +
      `以下词已经解释过，不要重复：${args.known.slice(0, 40).join('、') || '无'}\n` +
      `请列出原文中其余普通人不理解的专业术语及字面含义。`,
  });

  if (!object) return { ok: false, reason: 'failed', message: '模型调用失败，可稍后再试' };

  return { ok: true, terms: sanitizeTerms(object, clipped, args.known) };
}
