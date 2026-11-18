/**
 * 一键全量验证 —— 交付前的最终检查
 *
 * 用法：pnpm verify:all
 *
 * ============ 它做什么 ============
 *
 * 按"从零件到整机"的顺序依次跑六层：
 *
 *   1. 代码规范      eslint（语法与风格，最快的一层，先挡掉低级问题）
 *   2. 类型检查      tsc -b --noEmit（前端合约是否自洽）
 *   3. 单元测试      vitest run + mvn test（每个零件正确）
 *   4. E2E 多轮      e2e:multiturn（对话逻辑）
 *   5. E2E 缺陷回归  e2e:regressions（修过的不再坏）
 *   6. 生产构建      e2e:prod（打包后能跑）
 *
 * ============ 为什么需要统一入口 ============
 *
 * 分开跑都通过，**不代表一起跑也通过**：
 *   · 端口冲突：e2e:prod 起 5199，如果 dev server 也在跑要能共存
 *   · 状态污染：e2e:multiturn 会开会话，e2e:regressions 会发请求，
 *     顺序不同可能互相影响（比如后端重启导致 token 失效）
 *   · 依赖顺序：后端没起时 e2e:regressions 的 R4/R5 会跳过，
 *     而跳过不该算"通过"—— 这个入口会**明确报告哪些被跳过**
 *
 * ============ 前置条件检查 ============
 *
 * 这个脚本**不自己起服务**（除了 e2e:prod，它自己管理生命周期）。
 * 因为它要验证的是"你现在的环境"，而不是"它自己搭的环境"。
 * 缺服务时明确告诉你该起哪个，而不是静默跳过。
 */

import { spawn } from 'node:child_process';

interface Step {
  name: string;
  /** 执行的命令（shell 形式） */
  cmd: string;
  /** 前置条件检查；返回 false 表示跳过 */
  require?: () => Promise<{ ok: boolean; why: string }>;
  /** 跳过时算不算失败 */
  optional?: boolean;
}

const BFF = 'http://localhost:5173';
const BACKEND = 'http://localhost:8080';

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

const STEPS: Step[] = [
  {
    name: '代码规范',
    /*
     * 放第一步，因为它最快（约 8 秒），且没必要等问题等到 tsc 跑完才报。
     * 口径：error 才算失败；warning 放行 —— 目前留 5 条 warning，
     * 是 lab-values.ts 正则里刻意保留的方括号转义（见 eslint.config.js）。
     */
    cmd: 'npx eslint . --ext .ts,.tsx',
  },
  {
    name: '类型检查',
    cmd: 'npx tsc -b --noEmit',
  },
  {
    name: '前端单元测试',
    cmd: 'npx vitest run',
  },
  {
    name: '后端单元测试',
    /*
     * Maven 用 JAVA_HOME 找 JDK，但 `java` 不一定在 PATH 里
     * （实测本机就是这种情况：JAVA_HOME 设了，PATH 没有）。
     * 同理 mvn 也可能不在 PATH —— 都支持用环境变量指定。
     */
    cmd: `cd ../backend && "${process.env.MVN ?? 'mvn'}" -B test`,
    require: async () => {
      const { existsSync } = await import('node:fs');
      const { join } = await import('node:path');

      // 1. JDK：JAVA_HOME 优先，再看 PATH
      const javaHome = process.env.JAVA_HOME;
      const javaExe = process.platform === 'win32' ? 'java.exe' : 'java';
      let hasJdk = Boolean(javaHome && existsSync(join(javaHome, 'bin', javaExe)));
      if (!hasJdk) {
        hasJdk = await new Promise<boolean>((res) => {
          const p = spawn('java', ['-version'], { shell: true, stdio: 'ignore' });
          p.on('exit', (c) => res(c === 0));
          p.on('error', () => res(false));
        });
      }
      if (!hasJdk) {
        return {
          ok: false,
          why: '未找到 JDK 17（设置 JAVA_HOME，或把 java 加进 PATH）',
        };
      }

      // 2. Maven：MVN 环境变量优先，再看 PATH
      const mvn = process.env.MVN ?? 'mvn';
      const hasMvn = await new Promise<boolean>((res) => {
        const p = spawn(`"${mvn}" -v`, { shell: true, stdio: 'ignore' });
        p.on('exit', (c) => res(c === 0));
        p.on('error', () => res(false));
      });
      return {
        ok: hasMvn,
        why: hasMvn ? '' : `未找到 maven（设置 MVN 环境变量，或把 mvn 加进 PATH）`,
      };
    },
  },
  {
    name: 'E2E 多轮对话',
    cmd: 'npx tsx scripts/e2e-multiturn.ts',
    require: async () => {
      const ok = await reachable(`${BFF}/api/health`);
      return { ok, why: ok ? '' : 'BFF 未启动（cd frontend && pnpm dev）' };
    },
  },
  {
    name: 'E2E 缺陷回归',
    cmd: 'npx tsx scripts/e2e-regressions.ts',
    require: async () => {
      const ok = await reachable(`${BFF}/api/health`);
      return { ok, why: ok ? '' : 'BFF 未启动（cd frontend && pnpm dev）' };
    },
  },
  {
    name: '生产构建验证',
    cmd: 'npx tsx scripts/e2e-prod.ts',
    // 自己管理服务生命周期，不需要前置条件
  },
];

interface Outcome {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail: string;
  ms: number;
}

async function runStep(step: Step): Promise<Outcome> {
  if (step.require) {
    const pre = await step.require();
    if (!pre.ok) {
      return { name: step.name, status: 'skip', detail: pre.why, ms: 0 };
    }
  }

  const started = Date.now();
  const code = await new Promise<number>((res) => {
    const p = spawn(step.cmd, { shell: true, stdio: 'inherit', env: process.env });
    p.on('exit', (c) => res(c ?? 1));
    p.on('error', () => res(1));
  });

  return {
    name: step.name,
    status: code === 0 ? 'pass' : 'fail',
    detail: code === 0 ? '' : `exit=${code}`,
    ms: Date.now() - started,
  };
}

async function main() {
  console.log('='.repeat(64));
  console.log('智诊通 · 全量验证');
  console.log('='.repeat(64));

  /* ---- 环境概览：先告诉用户现在是什么状态 ---- */
  const [bffUp, beUp] = await Promise.all([
    reachable(`${BFF}/api/health`),
    reachable(`${BACKEND}/api/health`),
  ]);
  console.log('\n环境：');
  console.log(`  BFF     ${bffUp ? '✔ 运行中' : '✘ 未启动'}`);
  console.log(`  后端    ${beUp ? '✔ 运行中' : '✘ 未启动（病历页会降级，AI 对话不受影响）'}`);
  if (!bffUp) {
    console.log('\n提示：E2E 相关检查会被跳过。需要时先执行 cd frontend && pnpm dev');
  }

  const outcomes: Outcome[] = [];
  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i]!;
    console.log('\n' + '─'.repeat(64));
    console.log(`[${i + 1}/${STEPS.length}] ${step.name}`);
    console.log('─'.repeat(64));
    const o = await runStep(step);
    outcomes.push(o);
    if (o.status === 'skip') {
      console.log(`  ⤼ 跳过：${o.detail}`);
    } else {
      console.log(`  ${o.status === 'pass' ? '✔ 通过' : '✘ 失败'} (${(o.ms / 1000).toFixed(1)}s)`);
    }
  }

  /* ---- 汇总 ---- */
  const pass = outcomes.filter((o) => o.status === 'pass');
  const fail = outcomes.filter((o) => o.status === 'fail');
  const skip = outcomes.filter((o) => o.status === 'skip');

  console.log('\n' + '='.repeat(64));
  console.log('汇总');
  console.log('='.repeat(64));
  for (const o of outcomes) {
    const mark = o.status === 'pass' ? '✔' : o.status === 'fail' ? '✘' : '⤼';
    const time = o.ms > 0 ? ` ${(o.ms / 1000).toFixed(1)}s` : '';
    console.log(`  ${mark} ${o.name}${time}${o.detail ? ` — ${o.detail}` : ''}`);
  }

  console.log(`\n通过 ${pass.length} / 失败 ${fail.length} / 跳过 ${skip.length}`);

  /*
   * 跳过不等于通过。有跳过时明确说清楚"这部分没验"，
   * 否则一个全绿的报告会让人误以为什么都验过了。
   */
  if (skip.length > 0) {
    console.log('\n⚠ 有检查被跳过 —— 上面标 ⤼ 的项本轮**没有验证**。');
  }

  if (fail.length > 0) {
    console.log('\n✘ 存在失败项。');
    process.exitCode = 1;
  } else if (skip.length > 0) {
    console.log('\n△ 已运行的检查全部通过，但有项目被跳过。');
  } else {
    console.log('\n✔ 全部通过。');
  }
}

main().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exitCode = 1;
});
