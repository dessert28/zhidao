#!/usr/bin/env node
/*
 * 关闭开发服务。
 *
 * 为什么需要这个：
 *   `pnpm dev` 被 Ctrl+C 之外的方式中断（关掉终端窗口、IDE 里停任务、
 *   脚本后台启动后 Shell 退出），Vite 进程会留在后台继续占着端口。
 *   下次 `pnpm dev` 就自动跳到 5174，而浏览器还开在 5173 上看旧页面；
 *   更坑的是改了 tailwind.config.js 之后，那个旧进程不会重新生成工具类，
 *   页面看起来像"样式全丢了"。
 *
 * 做法：按端口找 LISTENING 的进程再关掉，不去 grep 命令行猜进程名。
 * 安全阀：默认只关 node 进程 —— 5173 上万一跑着别人的东西，
 *        脚本会跳过并告诉你，要关得自己加 --force。
 *
 * 用法：
 *   node scripts/dev-stop.mjs               关 5173 / 5174 / 4173
 *   node scripts/dev-stop.mjs 5173 8080     关指定端口
 *   node scripts/dev-stop.mjs --dry-run     只看占了什么，不动手
 *   node scripts/dev-stop.mjs --force       连非 node 进程也关（慎用）
 *
 * 也可以 `pnpm dev:stop`。
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

/** 默认要清的端口：dev、备用 dev、preview。后端 8080 不碰 —— 那通常是 Java，重启代价大 */
const DEFAULT_PORTS = [5173, 5174, 4173];

const isWin = process.platform === 'win32';

function parseArgs(argv) {
  const ports = [];
  let dryRun = false;
  let force = false;

  for (const a of argv) {
    if (a === '--dry-run' || a === '-n') dryRun = true;
    else if (a === '--force' || a === '-f') force = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (/^\d+$/.test(a)) ports.push(Number(a));
    else {
      console.error(`不认识的参数：${a}（--help 看用法）`);
      process.exit(2);
    }
  }

  return { ports: ports.length > 0 ? ports : DEFAULT_PORTS, dryRun, force };
}

function printHelp() {
  console.log(`
关闭残留的开发服务

  node scripts/dev-stop.mjs [端口…] [--dry-run] [--force]

  不带端口      清 ${DEFAULT_PORTS.join(' / ')}
  --dry-run     只列出监听进程，不关
  --force       连非 node 进程也关（默认跳过并提示）
`);
}

/* ---------------------------------------------------------------- 查端口 */

/** @returns {{pid:number, name:string}[]} */
function listenersOn(port) {
  return isWin ? listenersOnWindows(port) : listenersOnUnix(port);
}

function listenersOnWindows(port) {
  let out = '';
  try {
    // -a 全部连接 -n 数字 -o 显示 PID；只筛 LISTENING 避免把已建立的连接算进来
    out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
  } catch {
    return [];
  }

  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (!m) continue;
    if (Number(m[1]) !== port) continue;
    const pid = Number(m[2]);
    if (pid > 0) pids.add(pid);
  }

  return [...pids].map((pid) => ({ pid, name: processNameWindows(pid) }));
}

function processNameWindows(pid) {
  try {
    // /NH 去掉表头；CSV 输出形如 "node.exe","44652","Console","1","120,000 K"
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/^"([^"]+)"/m);
    return m ? m[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

function listenersOnUnix(port) {
  try {
    // lsof -t 只吐 PID，-sTCP:LISTEN 排除客户端连接
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => n > 0)
      .map((pid) => ({ pid, name: processNameUnix(pid) }));
  } catch {
    return [];
  }
}

function processNameUnix(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

/* ---------------------------------------------------------------- 关进程 */

function kill(pid) {
  if (isWin) {
    // /T 连带子进程：pnpm → node → vite 是一条链，只杀最上面那个会留孤儿
    execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

function stillListening(port) {
  return listenersOn(port).length > 0;
}

/* -------------------------------------------------------------------- 主 */

const { ports, dryRun, force } = parseArgs(process.argv.slice(2));

let closed = 0;
let skipped = 0;
let failed = 0;

for (const port of ports) {
  const found = listenersOn(port);

  if (found.length === 0) {
    console.log(`  :${port}  未占用`);
    continue;
  }

  for (const { pid, name } of found) {
    const isNode = /node|bun|deno/i.test(name);

    if (!isNode && !force) {
      // 不是我们起的就不动。误杀别人的服务的代价，远大于多跑一次 --force
      console.log(`  :${port}  ${name}(pid ${pid}) 不是 node 进程，跳过（要关请加 --force）`);
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(`  :${port}  ${name}(pid ${pid}) 将被关闭（--dry-run，未执行）`);
      continue;
    }

    try {
      kill(pid);
      console.log(`  :${port}  已关闭 ${name}(pid ${pid})`);
      closed += 1;
    } catch (err) {
      console.log(`  :${port}  关闭 ${name}(pid ${pid}) 失败：${err.message}`);
      failed += 1;
    }
  }
}

if (!dryRun && closed > 0) {
  // Windows 的端口释放有一两秒延迟，立刻重新 netstat 会得到假阳性
  await new Promise((r) => setTimeout(r, 600));
  const lingering = ports.filter(stillListening);
  if (lingering.length > 0) {
    console.log(`\n注意：${lingering.map((p) => `:${p}`).join(' ')} 仍在监听，可能有权限不足的进程。`);
    failed += 1;
  }
}

if (!dryRun) {
  const parts = [`关闭 ${closed} 个`];
  if (skipped > 0) parts.push(`跳过 ${skipped} 个`);
  if (failed > 0) parts.push(`失败 ${failed} 个`);
  console.log(`\n完成：${parts.join('，')}。现在可以重新 \`pnpm dev\`。`);
}

process.exit(failed > 0 ? 1 : 0);
