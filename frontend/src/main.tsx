/* ------------------------------------------------------------------
 * 应用入口
 * ------------------------------------------------------------------ */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import './index.css';

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
