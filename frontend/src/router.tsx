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
        /*
         * 首页 = 今日清单。
         *
         * 原来的首页是问诊输入框，但那是「有症状时」才用的。
         * 慢性病患者一年问诊几次，吃药却是每天两三次 ——
         * 每天真正要回答的是「今天我该做什么」。
         * 问诊页保留在 /chat，导航里仍有入口。
         */
        index: true,
        lazy: async () => {
          const { default: TodayPage } = await import('./pages/TodayPage');
          return { Component: TodayPage };
        },
      },
      {
        path: 'chat',
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
        /*
         * 就诊摘要。单独一页而不是挂在病历页下面：
         * 它的使用场景是「打印出来带去门诊」，需要一个干净的、
         * 可以直接 Ctrl+P 的页面，不能被其他区块干扰。
         */
        path: 'summary',
        lazy: async () => {
          const { default: SummaryPage } = await import('./pages/SummaryPage');
          return { Component: SummaryPage };
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
