/**
 * 生产构建验证 —— 一条进程托管静态产物 + BFF
 *
 * 用法：pnpm e2e:prod
 *      （脚本自己 build、自己起服务、自己清理，不需要提前启动任何东西）
 *
 * ============ 为什么需要这个 ============
 *
 * 开发模式（pnpm dev）和生产模式（pnpm build && pnpm start）走的是
 * **两条不同的代码路径**：
 *
 *   开发：Vite 中间件 + HMR，server/ 通过 configureServer 挂载
 *   生产：dist/ 静态产物 + @hono/node-server 的 serveStatic
 *
 * 之前只验证过 `vite build` 能通过 —— 那只能证明"能编译"，
 * 不能证明"跑得起来"。几类问题只在生产模式暴露：
 *   · serveStatic 的 root 相对 cwd 解析，绝对路径在 Windows 上会拼错
 *   · SPA 路由回退（/records 这类前端路由要返回 index.html）
 *   · 静态资源 404（路径前缀不一致）
 *   · .env 没被加载（standalone 比 dev 多一个加载时机问题）
 *
 * 这些都是"dev 好好的，一 build 就坏"的经典形态。
 *
 * ============ 做法 ============
 *
 * 用一个**独立端口**起服务（默认 5199），不干扰正在跑的 dev server。
 * 跑完 kill 掉进程并删 dist —— 验证脚本不该给环境留垃圾。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

/* 脚本总是从 frontend 目录运行（pnpm 按 package.json 的 cwd 执行） */

const PORT = Number(process.env.PROD_TEST_PORT ?? 5199);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = process.cwd();

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? `\n      ${detail}` : ''}`);
}

/** 等端口可用，最多 timeoutMs */
async function waitUp(timeoutMs = 40000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolvePromise) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true });
    p.on('exit', (code) => resolvePromise(code ?? 1));
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('生产构建验证');
  console.log('='.repeat(60));

  /* ---- 1. 清理旧产物并 build ---- */
  const dist = resolve(ROOT, 'dist');
  if (existsSync(dist)) {
    console.log('\n清理旧 dist…');
    rmSync(dist, { recursive: true, force: true });
  }

  console.log('\n[1] 构建');
  const buildCode = await run('npx', ['vite', 'build']);
  record('vite build 成功', buildCode === 0, buildCode === 0 ? '' : `exit=${buildCode}`);
  if (buildCode !== 0) {
    console.error('\n✘ 构建失败，后续检查无法进行');
    process.exit(1);
  }

  const indexHtml = resolve(dist, 'index.html');
  record('产出 dist/index.html', existsSync(indexHtml), indexHtml);

  /* ---- 2. 起生产服务 ---- */
  console.log('\n[2] 启动生产服务（PORT=' + PORT + '）');
  let server: ChildProcess | null = null;
  try {
    server = spawn('node', ['--import', 'tsx', 'server/standalone.ts'], {
      cwd: ROOT,
      // 用不同端口，避免和正在跑的 dev server 抢 5173
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
      shell: true,
    });

    const up = await waitUp();
    record('服务在 ' + PORT + ' 就绪', up, up ? '' : '40 秒内未响应');
    if (!up) {
      console.error('\n✘ 服务未启动，无法继续');
      return;
    }

    /* ---- 3. 健康检查与配置 ---- */
    console.log('\n[3] 健康检查');
    const health = await (await fetch(`${BASE}/api/health`)).json() as {
      ok: boolean;
      llmConfigured: boolean;
      mode: string;
    };
    record('/api/health 返回 ok', health.ok === true, `mode=${health.mode}, llm=${health.llmConfigured}`);
    /*
     * 生产模式下 .env 也要被读到。standalone.ts 比 dev 多一个
     * "在 createApp 之前就读 process.env" 的时机问题 —— 这条是那次的回归。
     */
    record('生产模式读到 .env（llmConfigured 与 dev 一致）', typeof health.llmConfigured === 'boolean', `llmConfigured=${health.llmConfigured}`);

    /* ---- 4. 静态资源 ---- */
    console.log('\n[4] 静态资源');
    const home = await fetch(`${BASE}/`);
    const homeHtml = await home.text();
    record('首页 200', home.status === 200, `HTTP ${home.status}`);
    record('首页含构建后的 script 标签', /<script[^>]+src="\/assets\/[^"]+"/.test(homeHtml), '');
    record('首页不含 dev 模式标记（/src/main.tsx）', !homeHtml.includes('/src/main.tsx'), '');

    const fav = await fetch(`${BASE}/favicon.ico`);
    record('favicon 200', fav.status === 200, `HTTP ${fav.status}`);

    /* ---- 5. SPA 路由回退 ---- */
    console.log('\n[5] SPA 路由回退');
    for (const path of ['/records', '/some-unknown-page']) {
      const r = await fetch(`${BASE}${path}`);
      const html = await r.text();
      /*
       * 前端路由必须返回 index.html（由 React Router 接管）。
       * 返回 404 会让刷新页面直接白屏 —— 演示时最容易踩的坑之一。
       */
      record(`${path} 回退到 index.html`, r.status === 200 && html.includes('<!doctype html'), `HTTP ${r.status}`);
    }

    /* ---- 6. BFF 接口 ---- */
    console.log('\n[6] BFF 接口');
    const chatRes = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '肚子疼三天了，是胀痛' }),
    });
    const chatBody = await chatRes.text();
    record('/api/chat 可用（SSE 事件 >=3）', (chatBody.match(/^event:/gm) ?? []).length >= 3, `事件数 ${(chatBody.match(/^event:/gm) ?? []).length}`);

    /* ---- 7. 后端代理（后端没起时不算失败，但要说明）---- */
    console.log('\n[7] 后端代理');
    const beOk = await fetch('http://localhost:8080/api/health', { signal: AbortSignal.timeout(3000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (!beOk) {
      record('后端代理', true, '后端未启动，跳过（不影响前端主链路）');
    } else {
      const login = await fetch(`${BASE}/api/backend/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'demo', password: 'demo1234' }),
      });
      record('登录经 BFF 代理成功', login.status === 200, `HTTP ${login.status}`);
    }
  } finally {
    /* ---- 清理：杀进程 + 删 dist，不给环境留垃圾 ---- */
    if (server && !server.killed) {
      server.kill();
      /*
       * Windows 上 spawn 带 shell 会多一层 cmd，kill 父进程不会杀掉子进程，
       * 导致端口被占。tcprider 不能用，就靠 taskkill 按端口兜底。
       */
      if (process.platform === 'win32') {
        spawn('powershell', [
          '-NoProfile',
          '-Command',
          `Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
        ], { stdio: 'ignore' });
      }
    }
  }

  /* ---- 汇总 ---- */
  const failed = checks.filter((c) => !c.ok);
  console.log('\n' + '='.repeat(60));
  console.log(`结果：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length > 0) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ✘ ${f.name} — ${f.detail}`);
    /*
     * 失败时保留 dist 便于排查；成功才删。
     * 验证脚本不该给环境留垃圾，但也不该在出问题时销毁证据。
     */
    console.log('\n（dist 保留，便于排查）');
    process.exitCode = 1;
  } else {
    console.log('生产构建可用。');
    rmSync(dist, { recursive: true, force: true });
    console.log('已清理 dist。');
  }
}

main().catch((e) => {
  console.error('生产验证异常：', e);
  process.exitCode = 1;
});
