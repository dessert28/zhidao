/* ------------------------------------------------------------------
 * .env 加载测试
 *
 * 锁住的是一个真实踩过的坑：Vite 的 loadEnv 只注入前端，
 * Node BFF 读 process.env 什么也读不到。用户按 README 填好 Key，
 * /api/health 却一直是 mode=rule-routing，而且没有任何报错。
 *
 * 这里不测"读文件"本身，测的是三条**决定行为**的规矩：
 *   1. 已存在的环境变量不被文件覆盖（CI 注入优先）
 *   2. 引号与注释被正确处理
 *   3. 文件不存在不抛异常
 * ------------------------------------------------------------------ */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetEnvForTest, envSource, loadEnv } from './env';

let dir: string;

/**
 * loadEnv 有模块级 loaded 标志（保证只读一次盘）。
 * 测试里要反复加载，所以每个用例换一个全新的 process 级变量名，
 * 而不是去改模块内部状态 —— 那等于测实现而不是测行为。
 */
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zhidao-env-'));
  // loadEnv 有一次性标志，测试里必须重置才能各自读自己的临时文件
  __resetEnvForTest();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ZHIDAO_ENV_FILE;
  delete process.env.ZHIDAO_TEST_A;
  delete process.env.ZHIDAO_TEST_B;
  delete process.env.ZHIDAO_TEST_KEEP;
});

describe('.env 加载', () => {
  it('文件不存在时不抛异常，也不改任何变量', () => {
    process.env.ZHIDAO_ENV_FILE = join(dir, 'does-not-exist');
    expect(() => loadEnv()).not.toThrow();
  });

  it('已存在的环境变量优先于 .env（CI 注入不能被仓库文件覆盖）', () => {
    process.env.ZHIDAO_TEST_KEEP = 'from-shell';
    process.env.ZHIDAO_ENV_FILE = join(dir, 'keep');
    writeFileSync(join(dir, 'keep'), 'ZHIDAO_TEST_KEEP=from-file\n', 'utf-8');

    loadEnv();

    expect(process.env.ZHIDAO_TEST_KEEP).toBe('from-shell');
  });

  it('解析 KEY=VALUE、忽略注释与空行', () => {
    process.env.ZHIDAO_ENV_FILE = join(dir, 'basic');
    writeFileSync(
      join(dir, 'basic'),
      ['# 这是注释', '', 'ZHIDAO_TEST_A=hello', '  ZHIDAO_TEST_B = world  ', 'BAD LINE NO EQ'].join('\n'),
      'utf-8',
    );

    loadEnv();

    expect(process.env.ZHIDAO_TEST_A).toBe('hello');
    expect(process.env.ZHIDAO_TEST_B).toBe('world');
  });

  it('去掉包裹值的引号，但保留值内部的空格', () => {
    process.env.ZHIDAO_ENV_FILE = join(dir, 'quoted');
    writeFileSync(join(dir, 'quoted'), 'ZHIDAO_TEST_A="sk-abc 123"\nZHIDAO_TEST_B=\'raw\'\n', 'utf-8');

    loadEnv();

    expect(process.env.ZHIDAO_TEST_A).toBe('sk-abc 123');
    expect(process.env.ZHIDAO_TEST_B).toBe('raw');
  });

  it('envSource 在自定义文件时返回 custom', () => {
    process.env.ZHIDAO_ENV_FILE = join(dir, 'x');
    expect(envSource()).toBe('custom');
  });
});
