/* ------------------------------------------------------------------
 * pnpm verify:llm —— 一键确认"模型到底通没通"
 *
 * 存在的理由：README 承诺「填了 Key 就走真模型」，但这句话没法被验证。
 * 用户看到的表现永远是"AI 给的答案像是固定的"，却分不清是：
 *   ① 压根没配 Key
 *   ② Key 错了 / 过期
 *   ③ 网络或 baseURL 不对
 *   ④ 通了，但模型返回的东西不合 schema
 * 这四种的修法完全不同，所以这个脚本把它们分开报。
 *
 * 用法：
 *   cd frontend
 *   cp .env.example .env      # 填 LLM_API_KEY
 *   pnpm verify:llm
 *
 * 退出码：0 全通；1 有环节失败（方便接进 CI 或提交前检查）
 * ------------------------------------------------------------------ */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Node 不会自动读 .env（Vite 只把变量注入前端，BFF 跑在 Node 里读不到）。
 * 这里手写一个极简解析：只处理 KEY=VALUE 与 # 注释，
 * 不为一个十行需求引 dotenv。
 */
function loadEnvFile(file: string) {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return false;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    // 已经由 shell 显式设置的变量优先，不覆盖
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const ok = (s: string) => `${GREEN}✔${RESET} ${s}`;
const bad = (s: string) => `${RED}✘${RESET} ${s}`;
const warn = (s: string) => `${YELLOW}!${RESET} ${s}`;
const dim = (s: string) => `${DIM}${s}${RESET}`;

async function main(): Promise<number> {
  const envPath = resolve(process.cwd(), '.env');
  const hadEnv = loadEnvFile(envPath);

  console.log('\n智诊通 · 大模型连通性自检\n');

  console.log(hadEnv ? ok(`读取到 ${envPath}`) : warn(`未找到 .env（${envPath}），使用当前 shell 变量`));

  // 动态 import：必须在 loadEnvFile 之后，否则模块加载时读到的还是空的
  const { probeLlm, describeConfig, isLlmConfigured } = await import('../server/llm/client.js');
  const { planViaLlm } = await import('../server/agents/llm-impl.js');
  const { checkRedFlag } = await import('../server/agents/rules/red-flag.js');

  /* ---------- 第 1 关：配置 ---------- */
  if (!isLlmConfigured()) {
    console.log(bad('第 1 关 配置：未配置 LLM_API_KEY'));
    console.log(dim('\n  现在整条链路走规则路由（这是设计好的降级，不会崩）。'));
    console.log(dim('  要接真模型：在 frontend/.env 里填 LLM_API_KEY=sk-xxx，然后重跑本命令。\n'));
    return 1;
  }
  const d = describeConfig()!;
  console.log(ok(`第 1 关 配置：${d.provider} / ${d.model}`));

  /* ---------- 第 2 关：连通性 ---------- */
  const probe = await probeLlm();
  if (!probe.ok) {
    const stageText = {
      'no-config': '配置缺失',
      network: '连不上（网络或 baseURL 问题）',
      auth: '鉴权失败（Key 错或过期）',
      'bad-output': '模型输出不可解析',
    }[probe.stage];
    console.log(bad(`第 2 关 连通性：${stageText}`));
    console.log(dim(`\n  ${probe.detail}\n`));
    if (probe.stage === 'auth') {
      console.log(dim('  → 检查 .env 里的 LLM_API_KEY 是否复制完整、是否已欠费。'));
    } else if (probe.stage === 'network') {
      console.log(dim('  → 检查 LLM_BASE_URL 是否需要改成代理地址；或用 curl 直接试一下该域名。'));
    }
    console.log('');
    return 1;
  }
  console.log(ok(`第 2 关 连通性：${probe.latencyMs}ms，模型回「${probe.text.slice(0, 20)}」`));

  /* ---------- 第 3 关：结构化输出 ---------- */
  console.log(dim('  正在验证结构化输出（Supervisor 的 plan schema）…'));
  const plan = await planViaLlm('肚子疼三天了，是胀痛');
  if (!plan) {
    console.log(bad('第 3 关 结构化输出：模型没给出合法 plan（业务层会降级到规则路由，不会崩）'));
    console.log(dim('\n  → 这通常是模型不支持 JSON schema，或该 provider 的兼容层不支持 response_format。'));
    console.log(dim('  → 可以换 LLM_MODEL 为更强的模型再试。\n'));
    return 1;
  }
  console.log(ok(`第 3 关 结构化输出：decision=${plan.decision}，agents=[${plan.agents.join(', ')}]`));
  console.log(dim(`  reason（模型原话）：${plan.reason}`));

  /* ---------- 第 4 关：红线不经模型 ---------- */
  // 这一关不测模型，测的是"模型再强也绕不过红线"这条设计承诺
  const red = checkRedFlag('我爸突然胸口疼得厉害，还出冷汗');
  if (!red.hit) {
    console.log(bad('第 4 关 红线短路：急症文本没有被拦截 —— 这是回归，必须修'));
    return 1;
  }
  console.log(ok(`第 4 关 红线短路：命中 ${red.hit.type}（不经过模型，确定性规则）`));

  console.log(`\n${GREEN}全部通过。${RESET} 当前模式：真实大模型。`);
  console.log(dim('提示：模型能通 ≠ 答案一定对。Reviewer 的四维自检与安全规则表仍在兜底。\n'));
  return 0;
}

/**
 * 退出方式要小心。
 *
 * <p>第一版用 {@code process.exit(code)}，在 Windows 上偶发 libuv 断言崩溃：
 * <pre>
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
 * </pre>
 * 原因是 AI SDK 的 HTTP 客户端（undici）还有没关完的 socket / 定时器，
 * `process.exit` 在事件循环正在拆句柄时硬退，触发了 UV 的断言。
 * 虽然输出本身是对的，但退出码变成 3221226505（0xC0000409），
 * 接进 CI 会被当成"崩溃"而不是"检查未通过"。
 *
 * <p>改成设置 `exitCode` 后让事件循环自然结束 —— Node 会在所有句柄
 * 关掉之后自己退出，不再插手。
 */
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(bad(`自检脚本本身出错：${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
  },
);
