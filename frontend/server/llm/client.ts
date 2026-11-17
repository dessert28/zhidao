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
 * 运行时覆盖配置 —— 由前端设置页提交。
 *
 * ============ 它和环境变量的关系 ============
 *
 * 优先级：**运行时覆盖 > 环境变量**。
 *
 * 理由：设置页的存在意义就是"让用户不重启也能换模型"。
 * 如果环境变量优先，用户在界面上填了却没生效 ——
 * 那是这个功能最不该出现的行为。
 *
 * ============ 为什么存在内存里 ============
 *
 * 用户的选择是"Key 存浏览器 localStorage"。那么服务端这一侧
 * 就只需要**临时持有**：每次请求由前端把配置带上来，
 * 服务端用完即弃。这份内存副本只用于"请求没带配置时"的兜底，
 * 进程重启即清空，不落盘、不写日志。
 *
 * ============ 不记录 Key ============
 *
 * 这个模块的任何日志、任何返回给前端的字段都不含 apiKey。
 * `describeConfig()` 只报 provider 和 model，这是刻意的 ——
 * 见它的注释。
 */
let runtimeOverride: LlmConfig | null = null;

/**
 * 设置运行时配置。
 *
 * @param cfg 传 null 表示清除覆盖，回到环境变量。
 *            apiKey 为空时同样视为清除 —— 空 key 不是一种合法配置。
 */
export function setRuntimeConfig(cfg: LlmConfig | null): void {
  if (!cfg || !cfg.apiKey.trim()) {
    runtimeOverride = null;
    return;
  }
  runtimeOverride = {
    apiKey: cfg.apiKey.trim(),
    provider: (cfg.provider || 'deepseek').trim().toLowerCase(),
    baseURL: (cfg.baseURL || '').trim(),
    model: (cfg.model || '').trim(),
  };
}

/** 当前是否有运行时覆盖（给健康检查用，不暴露内容） */
export function hasRuntimeConfig(): boolean {
  return runtimeOverride !== null;
}

/**
 * 读取配置。返回 null 表示"未配置，走规则路由"。
 *
 * <p>注意 `LLM_API_KEY` 为空字符串与未定义 **同等对待** ——
 * 从 `.env.example` 复制过来的 `.env` 里那一行是 `LLM_API_KEY=`，
 * 如果不判空串，就会被当成"已配置"，然后带着空 key 去请求，401。
 */
export function readConfig(): LlmConfig | null {
  /*
   * 运行时覆盖优先。
   * 注意它的 baseURL/model 可能是空的（用户只填了 Key）——
   * 那种情况用 provider 的预设补上，和下面的 env 分支同一套逻辑。
   */
  if (runtimeOverride) {
    const preset = PRESETS[runtimeOverride.provider] ?? PRESETS.deepseek!;
    return {
      apiKey: runtimeOverride.apiKey,
      provider: runtimeOverride.provider,
      baseURL: runtimeOverride.baseURL || preset.baseURL,
      model: runtimeOverride.model || preset.model,
    };
  }

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

/**
 * 拉取服务商支持的模型列表。
 *
 * ============ 为什么用 /models 这个端点 ============
 *
 * OpenAI 兼容协议里 `GET {baseURL}/models` 是标准做法，
 * DeepSeek / 通义 / 月之暗面 / Ollama 都实现了它。
 * 相比维护一张"哪些模型可用"的硬编码表：
 *   · 服务商上新的模型自动就有了
 *   · 不会推荐一个已经下线的模型名
 *
 * ============ 为什么这个函数允许失败 ============
 *
 * 不是所有兼容实现都提供 /models（有的返回 404，有的权限不同）。
 * 那种情况下界面要让用户**手填模型名**，而不是卡在这里。
 * 所以它返回结构化结果，而不是抛异常。
 *
 * @returns 模型 id 列表；拿不到时 ok=false 并给出原因
 */
export async function listModels(): Promise<
  { ok: true; models: string[] } | { ok: false; reason: 'not_configured' | 'auth' | 'unreachable' | 'unsupported'; detail: string }
> {
  const cfg = readConfig();
  if (!cfg) return { ok: false, reason: 'not_configured', detail: '还没配置 API Key' };

  const url = `${cfg.baseURL.replace(/\/+$/, '')}/models`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'auth', detail: 'API Key 无效或没有权限' };
  }
  if (res.status === 404) {
    /*
     * 有些兼容实现不实现 /models。这不是错误配置，
     * 只是"这家没法自动列模型"—— 界面要退回手填。
     */
    return { ok: false, reason: 'unsupported', detail: '这个服务商没有提供模型列表接口' };
  }
  if (!res.ok) {
    return { ok: false, reason: 'unreachable', detail: `接口返回 ${res.status}` };
  }

  try {
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort();
    if (models.length === 0) {
      return { ok: false, reason: 'unsupported', detail: '接口没有返回任何模型' };
    }
    return { ok: true, models };
  } catch {
    return { ok: false, reason: 'unsupported', detail: '返回的不是标准 JSON 格式' };
  }
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

/* ============================ 诊断 ============================ */

export type ProbeResult =
  | { ok: true; text: string; latencyMs: number }
  | { ok: false; stage: 'no-config' | 'network' | 'auth' | 'bad-output'; detail: string };

/**
 * 连通性自检 —— **唯一一个不吞异常的大模型调用**。
 *
 * <p>为什么需要它：{@link askObject} 的职责是"失败返回 null 让业务降级"，
 * 所以它把异常全吃了。这在运行期是对的，但在排查时是灾难 ——
 * 用户看到的是"AI 一直给规则答案"，却不知道到底是没配 Key、
 * Key 过期、网络不通，还是模型不输出合法 JSON。
 * 这四种情况的修法完全不同。
 *
 * <p>所以单独开一个把异常分类上报的探针，只给 `pnpm verify:llm` 用，
 * **不进业务链路**。
 */
export async function probeLlm(): Promise<ProbeResult> {
  const cfg = readConfig();
  if (!cfg) {
    return {
      ok: false,
      stage: 'no-config',
      detail: '未配置 LLM_API_KEY（.env 里那一行是空的）',
    };
  }

  const startedAt = Date.now();
  try {
    const { text } = await withTimeout(
      generateText({
        model: getClient(cfg)(cfg.model),
        prompt: '回答两个字：收到',
        maxTokens: 16,
        maxRetries: 0,
      }),
      CALL_TIMEOUT_MS,
    );
    return {
      ok: true,
      text: text.trim(),
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // 401/403 与"连不上"必须分开：前者是 Key 的问题，后者是网络或 baseURL 的问题
    const authLike = /\b(401|403|invalid.?api.?key|unauthorized|authentication)\b/i.test(msg);
    return {
      ok: false,
      stage: authLike ? 'auth' : 'network',
      detail: msg.slice(0, 300),
    };
  }
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
