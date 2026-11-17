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
import { RouteErrorBoundary } from './components/RouteErrorBoundary';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    /*
     * 错误边界挂在根路由上而不是每个子路由：
     * 用户崩溃后仍然需要顶栏与导航（能自己走到别的页面），
     * 挂在子路由就等于连顶栏一起没了。
     */
    ErrorBoundary: RouteErrorBoundary,
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
        /*
         * 挂号。与对话里的预约卡并行，不是替代：
         * 对话那条路是"AI 帮你判断该挂哪个科，顺手给个号"，
         * 这一页是"我已经知道要挂什么，自己挑时段"。
         * 后者是高频动作，不该每次先讲一遍症状。
         */
        path: 'booking',
        lazy: async () => {
          const { default: BookingPage } = await import('./pages/BookingPage');
          return { Component: BookingPage };
        },
      },
      {
        /*
         * 到院。单独一页而不是挂在病历页下面：
         * 它的场景是「人已经站在门诊楼里」—— 要的是"现在去哪、
         * 还要等多久、药在哪拿"，和病历时间轴完全是两个时刻。
         * 埋进病历页意味着患者要滚很久才能看到最急的那条信息。
         */
        path: 'visit',
        lazy: async () => {
          const { default: VisitPage } = await import('./pages/VisitPage');
          return { Component: VisitPage };
        },
      },
      {
        /*
         * 「我的」。
         *
         * 改版前这一格是「我的病历」，其余资料型入口（健康管家、摘要）
         * 平铺在顶栏里，七个入口在 672px 里必须横滑 —— 最后两个等于不存在。
         * 现在顶栏只留动作级入口，资料全部收进这一页。
         */
        path: 'mine',
        lazy: async () => {
          const { default: MinePage } = await import('./pages/MinePage');
          return { Component: MinePage };
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
        /*
         * 模型设置。单独一页而不是塞进某个设置弹窗：
         * 评审现场大概率要现场填一次 Key，这一页要能被直接打开、
         * 能被写进文档、能截图。弹窗做不到后两点。
         */
        path: 'settings',
        lazy: async () => {
          const { default: SettingsPage } = await import('./pages/SettingsPage');
          return { Component: SettingsPage };
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
