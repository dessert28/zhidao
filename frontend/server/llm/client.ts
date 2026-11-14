/* ------------------------------------------------------------------
 * LLM 客户端 —— 全项目唯一的大模型出口
 *
 * 设计原则（改这里之前先读）：
 *
 *  1. **没有 Key 就是没有异常。** 所有导出函数在未配置时返回 null /
 *     走规则路径，而不是抛错。理由是"无 Key 也能完整演示"这条性质
 *     已经被写进 README 承诺给评委了（docs/10 D1），一旦某个调用点
 *     忘了判空，评审本地就会白屏。
 *
 *  2. **失败一次就放弃，不重试。** 业务层（supervisor / triage / reviewer）
 *     各自有降级阶梯：坏输出 → 规则兜底。在这里重试只会把
 *     一次 8 秒超时变成三次 24 秒，用户感知是"卡死"。
 *
 *  3. **只发脱敏文本。** 调用方传入的 text 已由浏览器端 redact() 处理过。
 *     这个函数不再做二次脱敏 —— 但也绝不记录原文到日志（见 describe）。
 *
 *  4. **不绑定具体供应商。** 走 OpenAI 兼容协议，DeepSeek / Qwen / Moonshot /
 *     Ollama 都能用，只改 baseURL。这样答辩现场换一家不用改代码。
 * ------------------------------------------------------------------ */

import { generateObject, generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';

/* ============================ 配置 ============================ */

/** 各家的默认网关与默认模型。留空时按 provider 取这里 */
const PRESETS: Record<string, { baseURL: string; model: string }> = {
  deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  // 本地 Ollama：不需要 Key（Ollama 不校验），把 LLM_API_KEY 设成任意非空值即可
  ollama: { baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
};

/** 单次调用的硬超时。比 Agent 的 8s 略短，保证先于 safeRun 触发降级 */
const CALL_TIMEOUT_MS = 12_000;

export interface LlmConfig {
  apiKey: string;
  provider: string;
  baseURL: string;
  model: string;
}

/**
 * 读取配置。返回 null 表示"未配置，走规则路由"。
 *
 * <p>注意 `LLM_API_KEY` 为空字符串与未定义 **同等对待** ——
 * 从 `.env.example` 复制过来的 `.env` 里那一行是 `LLM_API_KEY=`，
 * 如果不判空串，就会被当成"已配置"，然后带着空 key 去请求，401。
 */
export function readConfig(): LlmConfig | null {
  const apiKey = (process.env.LLM_API_KEY ?? '').trim();
  if (!apiKey) return null;

  const provider = (process.env.LLM_PROVIDER ?? 'deepseek').trim().toLowerCase();
  const preset = PRESETS[provider] ?? PRESETS.deepseek!;

  return {
    apiKey,
    provider,
    baseURL: (process.env.LLM_BASE_URL ?? '').trim() || preset.baseURL,
    model: (process.env.LLM_MODEL ?? '').trim() || preset.model,
  };
}

/** 是否接了真模型。前端不需要知道 Key，只需要知道"是不是走模型" */
export function isLlmConfigured(): boolean {
  return readConfig() !== null;
}

/** 给健康检查用：不暴露 key，只暴露"会用哪个模型" */
export function describeConfig(): { provider: string; model: string } | null {
  const cfg = readConfig();
  return cfg ? { provider: cfg.provider, model: cfg.model } : null;
}

let client: ReturnType<typeof createOpenAI> | null = null;

function getClient(cfg: LlmConfig) {
  // 缓存：每次 new 一个新 client 会重复建连接池
  client ??= createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
  return client;
}

/* ============================ 结构化调用 ============================ */

/**
 * 要一个符合 schema 的 JSON 对象回来。
 *
 * <p>失败（网络错、超时、模型不听话）一律返回 null，由调用方决定降级。
 * 这里不抛异常，是因为**每个调用点的降级方式都不一样**：
 * Supervisor 退回规则路由、Triage 退回关键词表、Reviewer 退回规则分。
 * 在公共层统一处理会把三种不同的兜底糊成一种。
 */
export async function askObject<S extends z.ZodTypeAny>(args: {
  schema: S;
  system: string;
  prompt: string;
  temperature?: number;
}): Promise<z.infer<S> | null> {
  const cfg = readConfig();
  if (!cfg) return null;

  try {
    const { object } = await withTimeout(
      generateObject({
        model: getClient(cfg)(cfg.model),
        schema: args.schema,
        system: args.system,
        prompt: args.prompt,
        temperature: args.temperature ?? 0.2,
        // 关掉 AI SDK 的内建重试。它默认对可重试错误尝试 3 次，
        // 每次之间还有指数退避 —— 实测一次"连不上"要耗 6 秒。
        // 而我们的设计是"失败立刻降级到规则"，重试 3 次纯粹是把
        // 用户从"秒回"拖成"卡 6 秒"，最后还是走规则。
        maxRetries: 0,
      }),
      CALL_TIMEOUT_MS,
    );
    return object as z.infer<S>;
  } catch (err) {
    // 只记类型与一句截断信息，绝不记 prompt（里面有患者症状）
    console.warn('[llm] askObject 降级:', describe(err));
    return null;
  }
}

/** 纯文本生成，用于"自由作答"。同样失败返回 null */
export async function askText(args: {
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<string | null> {
  const cfg = readConfig();
  if (!cfg) return null;

  try {
    const { text } = await withTimeout(
      generateText({
        model: getClient(cfg)(cfg.model),
        system: args.system,
        prompt: args.prompt,
        temperature: args.temperature ?? 0.3,
        maxTokens: args.maxTokens ?? 600,
        maxRetries: 0, // 同 askObject：失败立刻降级，不陪 SDK 等退避
      }),
      CALL_TIMEOUT_MS,
    );
    return text.trim() || null;
  } catch (err) {
    console.warn('[llm] askText 降级:', describe(err));
    return null;
  }
}

/* ============================ 工具 ============================ */

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`llm timeout ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 把异常压成一行可读原因，不带任何用户文本 */
function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 160);
  return String(err).slice(0, 160);
}
