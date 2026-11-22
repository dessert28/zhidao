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
  /*
   * 登录 / 注册挂在根下、与 App 平级，而不是 App 的 children：
   * 这两个页面是"还没进入系统"的状态，顶栏的五个导航项、字号/主题切换
   * 对它毫无意义，套上去反而让人分不清自己是在登录还是在逛主界面。
   * 用 lazy 与主应用保持一致的首屏体积策略。
   */
  {
    path: '/login',
    lazy: async () => {
      const { default: LoginPage } = await import('./pages/LoginPage');
      return { Component: LoginPage };
    },
  },
  {
    path: '/register',
    lazy: async () => {
      const { default: RegisterPage } = await import('./pages/RegisterPage');
      return { Component: RegisterPage };
    },
  },
  {
    path: '/legal/:type',
    lazy: async () => {
      const { default: LegalPage } = await import('./pages/LegalPage');
      return { Component: LegalPage };
    },
  },
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
         * 隐私与脱敏：独立的说明页，不再把「隐私与脱敏」入口指到病历页。
         * 挂在 App 下而非顶层：页内的「谁看过你的数据」要读登录态接口。
         */
        path: 'privacy',
        lazy: async () => {
          const { default: PrivacyPage } = await import('./pages/PrivacyPage');
          return { Component: PrivacyPage };
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
        /*
         * 管理后台。
         *
         * 五个页面拆成五条平级路由而不是嵌套 + Outlet：
         * 后台的「tab」是导航而不是布局层级 —— 每个页面都要独立
         * 处理自己的加载/失败/空状态，套一层父路由只会多一个
         * 什么都不干的 <Outlet/>。tab 本身由 AdminShell 渲染。
         *
         * 路由存在不代表能用：真正的门禁在后端 hasRole("ADMIN")，
         * AdminShell 里的角色判断只是让患者别撞一脸 403。
         */
        path: 'admin',
        lazy: async () => {
          const { default: AdminDashboardPage } = await import('./pages/admin/AdminDashboardPage');
          return { Component: AdminDashboardPage };
        },
      },
      {
        path: 'admin/users',
        lazy: async () => {
          const { default: AdminUsersPage } = await import('./pages/admin/AdminUsersPage');
          return { Component: AdminUsersPage };
        },
      },
      {
        path: 'admin/hospitals',
        lazy: async () => {
          const { default: AdminHospitalsPage } = await import('./pages/admin/AdminHospitalsPage');
          return { Component: AdminHospitalsPage };
        },
      },
      {
        path: 'admin/notices',
        lazy: async () => {
          const { default: AdminNoticesPage } = await import('./pages/admin/AdminNoticesPage');
          return { Component: AdminNoticesPage };
        },
      },
      {
        path: 'admin/knowledge',
        lazy: async () => {
          const { default: AdminKnowledgePage } = await import('./pages/admin/AdminKnowledgePage');
          return { Component: AdminKnowledgePage };
        },
      },
      {
        /*
         * 医生工作台。和后台并列而不是子路由：医生不是管理员，
         * 他能看的只有「患者授权范围内的资料」，和后台的写操作
         * 是两套权限，混在一条路由树下会让守卫写成一团。
         */
        path: 'doctor',
        lazy: async () => {
          const { default: DoctorPage } = await import('./pages/DoctorPage');
          return { Component: DoctorPage };
        },
      },
      {
        /*
         * 预问诊摘要：后端契约已定但恒定 501。做成状态展示页而不是
         * 画一个假的输入框，避免演示时让人以为能力已经做完。
         */
        path: 'doctor/brief',
        lazy: async () => {
          const { default: DoctorBriefPage } = await import('./pages/DoctorBriefPage');
          return { Component: DoctorBriefPage };
        },
      },
      {
        /*
         * 工作边界：把只读、检索范围、空值口径、权限落地收敛成一页。
         * 医生看的是别人的病历，这些规则必须能被指着界面讲清楚。
         */
        path: 'doctor/policy',
        lazy: async () => {
          const { default: DoctorPolicyPage } = await import('./pages/DoctorPolicyPage');
          return { Component: DoctorPolicyPage };
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
