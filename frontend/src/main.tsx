/* ------------------------------------------------------------------
 * 应用入口
 * ------------------------------------------------------------------ */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { replaySavedLlmConfig } from './lib/llm-config-sync';
import './index.css';

/*
 * 应用启动时把浏览器里保存的模型配置重放给本地服务。
 *
 * 必须在渲染之前发起 —— 服务端只在进程内存里持有这份配置，
 * 服务一重启就丢了。不同步的话，用户会看到"我明明填过 Key，
 * 怎么又退回规则模式了"，而且没有任何提示解释原因。
 *
 * 不 await：同步失败不该阻塞首屏（规则模式本身可用）。
 */
void replaySavedLlmConfig();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 导诊场景下数据变化不频繁，但对新鲜度有要求
      staleTime: 30_000,
      retry: 1,
      // 医疗类页面上失焦不该反复重取（网络抖动时体验更差）
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
