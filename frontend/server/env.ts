/* ------------------------------------------------------------------
 * .env 加载 —— Vite 不会替 Node BFF 做这件事
 *
 * 这是个真实存在的坑，值得单独一个文件说明：
 *
 *   Vite 的 `loadEnv` 只把变量注入**前端**（`import.meta.env`），
 *   而 BFF 跑在 Node 里、读的是 `process.env`。
 *   换句话说：`frontend/.env` 里写了 LLM_API_KEY，
 *   `vite.config.ts` 和 `server/` 都**看不到**。
 *
 *   症状极具迷惑性：按 README 填了 Key、`pnpm dev` 也起来了，
 *   但 `/api/health` 一直是 `{"mode":"rule-routing"}` ——
 *   因为 `process.env.LLM_API_KEY` 压根没人往里写。
 *
 * 所以这个模块必须在 BFF 入口**最先**被 import（见 server/index.ts），
 * 早于任何读 process.env 的代码。
 *
 * 为什么手写解析而不引 dotenv：
 *   只需要支持 KEY=VALUE、# 注释、去引号这三点，二十行够了。
 *   引一个依赖意味着多一条供应链风险面，而这是官方仓库里
 *   唯一会接触用户密钥的文件。
 * ------------------------------------------------------------------ */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** BFF 根目录（frontend/）。本文件位于 frontend/server/env.ts */
const ROOT = resolve(import.meta.dirname, '..');

let loaded = false;

/**
 * 加载 `.env`。
 *
 * <p>三条规矩：
 * <ol>
 *   <li>**已存在的环境变量优先**。CI / 容器里注入的变量不该被仓库里的
 *       .env 覆盖 —— 那会让"线上改了环境变量却没生效"成为难查的谜题</li>
 *   <li>文件不存在不算错误。省赛演示允许不配 Key（走规则路由）</li>
 *   <li>幂等。被 import 多次也只读一次盘</li>
 * </ol>
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  // 依次尝试：显式指定的 → .env.local（个人覆盖，不入库）→ .env
  // 顺序即优先级，先读到的先占位
  const candidates = [
    process.env.ZHIDAO_ENV_FILE,
    resolve(ROOT, '.env.local'),
    resolve(ROOT, '.env'),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    applyFile(file);
    return; // 读到一个就停：.env.local 存在时不再被 .env 覆盖
  }
}

function applyFile(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    // 去掉包裹引号，但保留值内部的空格（密钥里可能有）
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // 已设置的不覆盖 —— 见函数注释第 1 条
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/** 供健康检查展示：当前是从哪里读到的配置（不暴露内容） */
export function envSource(): string {
  if (process.env.ZHIDAO_ENV_FILE) return 'custom';
  if (existsSync(resolve(ROOT, '.env.local'))) return '.env.local';
  if (existsSync(resolve(ROOT, '.env'))) return '.env';
  return 'process-env';
}

/**
 * 重置"已加载"标记，**仅供测试使用**。
 *
 * <p>生产环境不该调它：BFF 的生命周期里 .env 只该读一次，
 * 反复读盘没有意义，还会让"运行中改了 .env 但没重启"变成半生效的状态。
 *
 * <p>但测试必须能重来 —— 否则第一个用例读完之后，后面所有用例
 * 都拿不到自己的临时文件（这个坑当场就让两条用例失败了）。
 */
export function __resetEnvForTest(): void {
  loaded = false;
}
