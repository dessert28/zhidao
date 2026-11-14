/* ------------------------------------------------------------------
 * 端侧 NER 模型层 —— detectWithModel 的真正实现
 * 依据：docs/04 §3.1 端侧智能三件套 ①；docs/02 §端侧小模型候选
 *
 * ============ 为什么需要它 ============
 *
 * 规则引擎（redact.ts）能抓结构化 PII：身份证、手机号、地址、银行卡 ——
 * 这些有固定形状。但**自由叙述里的人和地名它抓不住**：
 *
 *   「老王让我带他上次的片子」
 *   「我住梧桐里社区那边」
 *
 * 「老王」「梧桐里」都不是固定形状，正则无能为力。这正是 NER 模型的活。
 *
 * ============ 三个必须处理好的现实约束 ============
 *
 * 1. **体积**。量化后的多语言 DistilBERT NER 是 ~129MB。
 *    绝不能进首屏包，也绝不能进首屏请求 —— 所以：
 *      · 走动态 import()，不进主 chunk（见 vite.config manualChunks 的用意）
 *      · 用户第一次打字后才加载，而不是页面一打开就下
 *
 * 2. **网络**。模型权重在 HuggingFace。国内**主站与 cdn-lfs 都不通**（实测），
 *    但 hf-mirror.com 可用。所以 remoteHost 必须可配，
 *    默认走镜像 —— 否则评委现场加载直接超时，功能等于没有。
 *
 * 3. **失败必须无害**。模型下载失败、WebGPU 不可用、推理异常 ——
 *    任何一种都只能让"多一层遮蔽"消失，不能让脱敏本身消失，
 *    更不能阻塞发送。所有路径都 catch 后返回 null，
 *    由调用方回退到纯规则结果。
 *
 * ============ 诚实边界 ============
 *
 * 这是 multilingual DistilBERT NER（英文/西/法/德/葡/荷 + 多语种混合），
 * **不是为中文微调的**。中文人名识别效果明显弱于英文人名。
 * 所以它定位为"规则之外的补充召回"，不是替代品：
 * 宁可多标（用户可以在预览里看到），不可漏标（那是真泄漏）。
 * ------------------------------------------------------------------ */

import type { PiiType } from './redact';

/** 模型产出的一条实体（相对原文的字符区间） */
export interface ModelEntity {
  type: PiiType;
  /** 原文切片，调用方拿到后可以决定是否真的遮蔽 */
  text: string;
  start: number;
  end: number;
  /** 模型置信度，供调试与"只接受高置信"策略使用 */
  score: number;
}

export type ModelState =
  | { status: 'idle' }
  | { status: 'loading'; progress: number; message: string }
  | { status: 'ready' }
  | { status: 'unavailable'; reason: string };

/* ============================ 配置 ============================ */

/**
 * 模型文件的来源。
 *
 * <p><b>默认走自家 BFF 代理，不是 HuggingFace。</b>
 *
 * <p>实测（2026-11-14，本机）：
 * <pre>
 *   huggingface.co            不可达
 *   cdn-lfs.huggingface.co    不可达
 *   hf-mirror.com             curl 可取（200），但**浏览器 fetch 被 CORS 拦**：
 *                             No 'Access-Control-Allow-Origin' header
 * </pre>
 *
 * <p>也就是说"镜像能用"在 curl 里是真的，在浏览器里是假的 ——
 * 这个结论只有真的把页面跑起来才会得到。
 *
 * <p>所以这里指向同源的 `/`（BFF 的模型代理路由）。
 * 好处：无 CORS、服务端可缓存（第二次启动不再依赖外网）、
 * 镜像挂了只需改服务端一个环境变量。
 *
 * <p>用相对路径而不是绝对 URL → 请求自动同源，
 * 部署到哪个域名都不用改代码。
 */
const DEFAULT_REMOTE_HOST = '';

/** 模型仓库。Xenova 是 transformers.js 官方的 ONNX 转换仓库 */
const MODEL_ID = 'Xenova/distilbert-base-multilingual-cased-ner-hrl';

/**
 * 只接受高置信实体。
 *
 * <p>阈值取 0.55 而不是 0.7：这是**隐私场景**，
 * 多遮蔽一个词的代价是"读起来别扭"，漏遮蔽的代价是"姓名发到了服务器"。
 * 但也不能取 0.3 —— 那会把"头晕三天"里的普通词也标成人名。
 */
const MIN_SCORE = 0.55;

/** 模型标签 → 我们的 PiiType。模型输出的是 BIO 标签，subtype 在 group 里 */
const LABEL_MAP: Record<string, PiiType> = {
  per: 'name',
  person: 'name',
  loc: 'address',
  location: 'address',
  org: 'address', // 机构名往往含地名信息，按住址类低敏处理
};

/* ============================ 状态与单例 ============================ */

let state: ModelState = { status: 'idle' };
const listeners = new Set<(s: ModelState) => void>();

function setState(next: ModelState) {
  state = next;
  for (const fn of listeners) fn(next);
}

export function getModelState(): ModelState {
  return state;
}

/** 订阅加载进度，供 UI 显示「正在加载本地脱敏模型 43%」 */
export function onModelStateChange(fn: (s: ModelState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 解析 remoteHost（transformers.js 拼 URL 的前缀）。
 *
 * <p>空字符串是**有效值**，表示"用同源相对路径"。
 * 注意不能给成 `location.origin`：那会让 dev 期变成
 * `http://localhost:5173/Xenova/...`，虽然也能命中 BFF，
 * 但生产部署换域名时就要改代码。相对路径天然跟着页面走。
 *
 * <p>localStorage 覆盖留给"临时换源调试"：
 * {@code localStorage.setItem('zhidao:hf-mirror', 'https://hf-mirror.com')}
 * —— 但注意那样会绕开 BFF，浏览器 CORS 会拦（见文件头说明）。
 */
function remoteHost(): string {
  if (typeof localStorage !== 'undefined') {
    const override = localStorage.getItem('zhidao:hf-mirror');
    if (override !== null) return override;
  }
  return DEFAULT_REMOTE_HOST;
}

/* ============================ 加载 ============================ */

interface NerPipeline {
  (input: string, opts?: Record<string, unknown>): Promise<unknown>;
}

let pipelinePromise: Promise<NerPipeline | null> | null = null;

/**
 * 懒加载 pipeline。**同一个 Promise 复用**，并发调用不会重复下载 129MB。
 *
 * <p>为什么这里要 await import 而不是顶层 import：
 * transformers.js 连同 onnxruntime-web 有好几 MB 的 JS，
 * 静态引入会把首屏包从 ~200KB 撑到数 MB。
 * 用户在打字之前根本不需要它。
 */
function loadPipeline(): Promise<NerPipeline | null> {
  pipelinePromise ??= (async () => {
    try {
      setState({ status: 'loading', progress: 0, message: '正在准备本地脱敏模型…' });

      const mod = await import('@huggingface/transformers');

      // 把镜像地址写进 transformers.js 的环境配置
      mod.env.remoteHost = remoteHost();

      const pipe = await mod.pipeline('token-classification', MODEL_ID, {
        // 量化版本：129MB → 比 fp32 小一半以上，精度损失对本用途可接受
        dtype: 'q8',
        progress_callback: (p: { status?: string; progress?: number; file?: string }) => {
          if (p?.status === 'progress' && typeof p.progress === 'number') {
            setState({
              status: 'loading',
              progress: Math.round(p.progress),
              message: `正在下载本地脱敏模型 ${Math.round(p.progress)}%`,
            });
          }
        },
      });

      setState({ status: 'ready' });
      return pipe as unknown as NerPipeline;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setState({ status: 'unavailable', reason: reason.slice(0, 200) });
      // 失败后允许下次重试（比如网络恢复了）
      pipelinePromise = null;
      return null;
    }
  })();

  return pipelinePromise;
}

/* ============================ 推理 ============================ */

interface RawToken {
  entity_group?: string;
  entity?: string;
  word: string;
  score: number;
  start?: number;
  end?: number;
  index?: number;
}

/**
 * 从原文里识别 PII 实体。
 *
 * @returns 命中的实体数组；模型未就绪或失败时返回 **null**（不是空数组）
 *
 * <p>null 与 `[]` 的区别很重要：
 * <ul>
 *   <li>{@code []} = 模型跑过了，确实没找到</li>
 *   <li>{@code null} = 模型不可用，调用方应只依赖规则结果</li>
 * </ul>
 * 调用方如果分不清这两者，就会在模型没装时误以为"已经检查过一遍了"。
 */
export async function detectEntities(raw: string): Promise<ModelEntity[] | null> {
  if (!raw.trim()) return null;

  const pipe = await loadPipeline();
  if (!pipe) return null;

  try {
    const output = (await pipe(raw, { aggregation_strategy: 'simple' })) as RawToken[];
    if (!Array.isArray(output)) return null;

    const entities: ModelEntity[] = [];
    for (const t of output) {
      const label = (t.entity_group ?? t.entity ?? '').toLowerCase();
      // 标签形如 "PER" / "per" / "B-PER"；取最后一段判断
      const key = label.replace(/^[bi]-/, '').toLowerCase();
      const type = LABEL_MAP[key];
      if (!type) continue;
      if (typeof t.score === 'number' && t.score < MIN_SCORE) continue;

      // aggregation_strategy=simple 时会给出 start/end；没有就用词频查找兜底
      const start = typeof t.start === 'number' ? t.start : raw.indexOf(t.word);
      if (start < 0 || start === undefined) continue;
      const end = typeof t.end === 'number' ? t.end : start + t.word.length;

      const slice = raw.slice(start, end);
      if (!slice.trim()) continue;

      entities.push({ type, text: slice, start, end, score: t.score ?? 0 });
    }

    return entities;
  } catch {
    // 推理失败不改变 state —— 模型本身是好的，可能只是这一句太长
    return null;
  }
}

/** 预热：在用户可能输入时提前加载，减少第一次等待 */
export function warmUpModel(): void {
  if (state.status === 'idle') void loadPipeline();
}
