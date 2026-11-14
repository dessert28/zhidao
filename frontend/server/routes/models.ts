/* ------------------------------------------------------------------
 * 模型文件代理 —— 绕开浏览器 CORS，并把模型落到本地缓存
 *
 * ============ 为什么必须有这一层 ============
 *
 * transformers.js 在浏览器里用 fetch 直接拉 HuggingFace 的文件。
 * 实测（2026-11-14，本机）：
 *
 *   huggingface.co            不可达
 *   cdn-lfs.huggingface.co    不可达
 *   hf-mirror.com             curl 可取（HTTP 200），但**浏览器 fetch 被 CORS 拦**
 *                             报错：No 'Access-Control-Allow-Origin' header
 *
 * 也就是说镜像在 curl 里"能用"是假象 —— 浏览器场景下它不可用。
 * 这是只有真的在浏览器里跑一遍才会发现的问题。
 *
 * 解法：让模型文件走我们自己的 BFF。
 *   · 同源请求，CORS 天然不存在
 *   · 可以在服务端做一层磁盘缓存，第二次启动不再依赖外网
 *   · 可以按 remoteHost 灰度切换（镜像挂了改成别的源）
 *
 * ============ 边界 ============
 *
 * 这一层**不碰任何用户数据**，只搬运公开的模型权重。
 * 它不代表"把隐私数据上云"——模型是公开的，患者文本一行都不会经过这里。
 * 这个区分在答辩时要说清楚，否则会被误解成隐私架构倒退。
 * ------------------------------------------------------------------ */

import { Hono } from 'hono';
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const modelRoutes = new Hono();

/**
 * 允许的模型仓库白名单。
 *
 * <p><b>必须白名单，不能透传任意路径</b>：这个接口是匿名的（模型是公开的，
 * 没理由要求登录），如果放任 {repo} 与 {path} 拼出任意 URL，
 * 它就变成一个公开的 SSRF 跳板 —— 别人可以借我们的服务器
 * 访问内网地址或刷别人的流量。
 */
const ALLOWED_REPOS = new Set([
  'Xenova/distilbert-base-multilingual-cased-ner-hrl',
]);

/** 允许的文件名后缀。只放行模型运行必需的几类 */
const ALLOWED_EXT = /\.(json|onnx|txt|model|bin)$/i;

const CACHE_DIR = resolve(import.meta.dirname, '../../.cache/models');

/**
 * 上游源。
 *
 * <p><b>为什么默认是 ModelScope 而不是 HuggingFace 镜像：</b>
 *
 * <p>实测（2026-11-14 与 12:50 两次）：
 * <pre>
 *   huggingface.co           不可达
 *   cdn-lfs.huggingface.co   不可达
 *   hf-mirror.com            上午 200，下午 503 / 超时 —— 不稳定
 *   modelscope.cn            稳定 200，且有 Xenova 这份 ONNX 仓库的镜像
 * </pre>
 *
 * <p>两个源的文件路径格式不同，见 {@link upstreamUrl}。
 * 用环境变量 MODEL_ORIGIN 切换，不改代码。
 */
const ORIGIN = (process.env.MODEL_ORIGIN ?? 'https://modelscope.cn').replace(/\/+$/, '');

/** 用哪个源决定了 URL 模板。两家路径不一样，不能套同一个模板 */
type OriginKind = 'modelscope' | 'huggingface';

function originKind(o: string): OriginKind {
  return /modelscope/i.test(o) ? 'modelscope' : 'huggingface';
}

/**
 * 拼上游 URL。
 *
 * <pre>
 *   HuggingFace：{origin}/{repo}/resolve/main/{file}
 *   ModelScope ：{origin}/models/{repo}/resolve/master/{file}
 *                 ↑ 注意 model**s** 前缀，且分支叫 master 不是 main
 * </pre>
 * 第一版只写了 HuggingFace 模板，切到 ModelScope 时 502 ——
 * 两家的路径约定不一致这件事，只有真的发一次请求才知道。
 */
function upstreamUrl(repo: string, file: string): string {
  if (originKind(ORIGIN) === 'modelscope') {
    return `${ORIGIN}/models/${repo}/resolve/master/${file}`;
  }
  return `${ORIGIN}/${repo}/resolve/main/${file}`;
}

/** 把仓库/文件映射到本地缓存路径，避免路径穿越 */
function cachePathFor(repo: string, file: string): string | null {
  // 只保留安全字符；.. / 绝对路径 / 反斜杠一律拒绝
  if (file.includes('..') || file.startsWith('/') || file.includes('\\')) return null;
  const safe = `${repo.replace(/\//g, '__')}__${file.replace(/\//g, '__')}`;
  const full = join(CACHE_DIR, safe);
  // 二次确认：拼出来的路径必须仍在缓存目录内
  if (!resolve(full).startsWith(CACHE_DIR)) return null;
  return full;
}

modelRoutes.get('/:repo{.+}/resolve/main/:file{.+}', async (c) => {
  const repo = c.req.param('repo');
  const file = c.req.param('file');

  if (!ALLOWED_REPOS.has(repo)) {
    return c.json({ error: 'repo_not_allowed' }, 403);
  }
  if (!ALLOWED_EXT.test(file)) {
    return c.json({ error: 'file_type_not_allowed' }, 403);
  }

  const cached = cachePathFor(repo, file);

  /* ---------- 命中缓存：直接吐本地文件 ---------- */
  if (cached && existsSync(cached)) {
    const data = await readFile(cached);
    return c.body(new Uint8Array(data), 200, {
      'Content-Type': 'application/octet-stream',
      // 模型文件是内容寻址的（同名即同内容），可以放心长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Zhidao-Cache': 'hit',
    });
  }

  /* ---------- 未命中：回源并顺带落盘 ---------- */
  const upstream = upstreamUrl(repo, file);
  let resp: Response;
  try {
    resp = await fetch(upstream, {
      headers: { 'user-agent': 'zhidao-bff/1.0 (+model-proxy)' },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    // 回源失败要说清楚是哪一步，否则前端只看到"模型加载失败"
    console.warn('[model-proxy] 回源失败', file, err instanceof Error ? err.message : err);
    return c.json({ error: 'upstream_unreachable', file }, 502);
  }

  if (!resp.ok || !resp.body) {
    console.warn('[model-proxy] 上游返回', resp.status, file);
    return c.json({ error: 'upstream_error', status: resp.status, file }, 502);
  }

  const headers: Record<string, string> = {
    'Content-Type': resp.headers.get('content-type') ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Zhidao-Cache': 'miss',
  };
  const len = resp.headers.get('content-length');
  if (len) headers['Content-Length'] = len;

  /*
   * 大于 8MB 的文件（本质上就是 .onnx 权重）走"边下载边落盘"，
   * 不把 129MB 整个读进内存 —— 否则并发两个请求就能把进程打爆。
   *
   * 小的配置文件直接读进内存，简单可靠。
   */
  const size = len ? Number(len) : 0;
  if (size > 8 * 1024 * 1024) {
    /*
     * 大文件：边下边落盘，再从磁盘流出去。
     *
     * 这里第一版写错过 —— 落盘之后又 readFile 把 129MB 读回内存再吐，
     * 等于"流式落盘"白做了，两个并发请求就能把进程 RSS 顶到 300MB+。
     * 正确做法是落盘完成后用 createReadStream 从磁盘流出去，
     * 内存占用与文件大小无关。
     */
    if (cached) {
      try {
        mkdirSync(CACHE_DIR, { recursive: true });
        // 先写临时文件再改名：避免半截文件被下一次请求当成缓存命中
        const tmp = `${cached}.downloading`;
        await pipeline(Readable.fromWeb(resp.body as never), createWriteStream(tmp));
        const { renameSync, createReadStream } = await import('node:fs');
        renameSync(tmp, cached);
        const stream = createReadStream(cached);
        return new Response(Readable.toWeb(stream) as ReadableStream, {
          status: 200,
          headers: { ...headers, 'Content-Length': String(statSync(cached).size) },
        });
      } catch (err) {
        console.warn('[model-proxy] 缓存写入失败', err instanceof Error ? err.message : err);
        return c.json({ error: 'cache_write_failed', file }, 500);
      }
    }
    // 没有缓存路径（理论上白名单内不会发生）：直接透传，不落盘
    return new Response(resp.body, { status: 200, headers });
  }

  const buf = new Uint8Array(await resp.arrayBuffer());
  if (cached) {
    try {
      mkdirSync(CACHE_DIR, { recursive: true });
      await import('node:fs/promises').then((fs) => fs.writeFile(cached, buf));
    } catch {
      /* 缓存失败无所谓，下次再取 */
    }
  }
  return c.body(buf, 200, headers);
});

/** 缓存概览，给 health 与排查用 */
export function cacheSummary(): { files: number; bytes: number } {
  try {
    if (!existsSync(CACHE_DIR)) return { files: 0, bytes: 0 };
    let bytes = 0;
    let files = 0;
    for (const n of readdirSync(CACHE_DIR)) {
      // 跳过正在下载的临时文件，否则会把半截体积算进去
      if (n.endsWith('.downloading')) continue;
      try {
        bytes += statSync(join(CACHE_DIR, n)).size;
        files++;
      } catch {
        /* 文件在两次调用之间被删掉，忽略 */
      }
    }
    return { files, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}
