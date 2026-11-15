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
        /*
         * 健康管家。
         *
         * 单独一个页面而不是塞进病历页：病历页是"我上传过什么"，
         * 健康管家是"这些数据说明我现在怎样、接下来该做什么"。
         * 两件事放一起，患者会分不清该看哪块。
         */
        path: 'health',
        lazy: async () => {
          const { default: HealthPage } = await import('./pages/HealthPage');
          return { Component: HealthPage };
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
