// ------------------------------------------------------------------
// 智诊通 · ESLint 扁平配置（ESLint 9）
//
// 为什么自己写而不是 `eslint --init` 生成的：
//   init 会给一份带 react-refresh 的全家桶，但这个项目的 BFF（server/）
//   是 Node 环境，不是 React，全家桶会把 server 代码按浏览器规则误判。
//   这里按目录分两段 files，各管各的。
//
// 规则口径（刻意保守，避免"改一个报十个"）：
//   · 只开 recommended，不开 type-checked 规则集
//     —— 类型问题由 `pnpm typecheck`（tsc strict）兜底，职责不重叠
//   · no-undef 在 TS 文件里关闭
//     —— TS 编译器已经做了更准的检查，ESLint 的版本不认识 TS 类型导入
//   · no-unused-vars 允许 `_` 前缀
//     —— 接口实现里占位参数、catch 里刻意忽略的错误都靠这个约定
// ------------------------------------------------------------------

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // 构建产物与本机缓存不参与检查
  {
    ignores: [
      'dist/**',
      'build/**',
      'node_modules/**',
      '.cache/**',
      'coverage/**',
      '*.config.js',
      '*.config.ts',
    ],
  },

  // ---------- 通用：TS / TSX ----------
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        // 不开 project：type-aware 会拖慢到十几秒，且与 tsc 重复
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // TS 自己会检查未定义标识符，ESLint 的 no-undef 在 TS 里是噪音源
      'no-undef': 'off',
      // 未使用变量：允许 `_` 前缀声明"我故意不用"
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // any 在 LLM 返回体解析处偶有必要，降级为提醒而不是报错
      '@typescript-eslint/no-explicit-any': 'warn',
      // 空接口在多处用于"标记类型"（如空 props），保留
      '@typescript-eslint/no-empty-object-type': 'off',
      // React Hooks 两条铁律，这个必须 error
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // 调试残留：warn 提醒，不阻断
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      // lab-values.ts 的正则在字符类里保留了 `\[`／`\]`：
      // 语义上确实多余（[ 在字符类内无需转义），但去掉后 `[（(【[]` 这种写法
      // 反而会被后来者误读成"漏了括号"的正则 bug。可读性优先，降为提醒。
      'no-useless-escape': 'warn',
    },
  },

  // ---------- 纯 Node 的 .mjs / .js（构建脚本）----------
  // 这些文件没有 typescript-eslint 的 parser 兜底，需要显式给 Node 全局量，
  // 否则 console / setTimeout 会被报成 no-undef。
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // ---------- 测试与脚本：放宽断言类规则 ----------
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', 'scripts/**/*.ts', 'server/**/*.ts'],
    rules: {
      // 测试里 `as any` 造残缺对象是常规手法；脚本本身就是 console 驱动
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
);
