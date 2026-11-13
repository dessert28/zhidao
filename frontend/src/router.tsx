/* ------------------------------------------------------------------
 * 路由：React Router 6 + 路由级懒加载
 * 依据：docs/04 §6 前端性能优化 3%（懒加载 / 代码分割）
 *
 * 为什么懒加载不是"炫技"：
 *   端侧脱敏模型（Transformers.js + WebGPU）体积在数 MB 量级，
 *   如果把病历页静态引入，首屏就会拖进这个包袱。
 *   挂号页的人也根本不需要它。
 * ------------------------------------------------------------------ */

import { createBrowserRouter } from 'react-router-dom';
import App from './App';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      {
        index: true,
        lazy: async () => {
          const { default: ChatPage } = await import('./pages/ChatPage');
          return { Component: ChatPage };
        },
      },
      {
        path: 'records',
        lazy: async () => {
          const { default: RecordsPage } = await import('./pages/RecordsPage');
          return { Component: RecordsPage };
        },
      },
      {
        path: '*',
        lazy: async () => {
          const { default: NotFoundPage } = await import('./pages/NotFoundPage');
          return { Component: NotFoundPage };
        },
      },
    ],
  },
]);
