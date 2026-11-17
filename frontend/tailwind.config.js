/** @type {import('tailwindcss').Config} */
export default {
  // 深色走 class 而不是 media：用户要能显式覆盖系统偏好（"我系统是深色但我要浅色"）。
  // 首帧由 index.html 里的内联脚本提前打好 .dark，不会白闪。
  darkMode: 'class',

  // ⚠️ server/ 必须在这里出现，否则生成式 UI 的卡片全部裸奔。
  //
  // 原因：卡片是服务端 renderToString 出来的 HTML 字符串，
  // 客户端只把它塞进 innerHTML，那些 class 名<b>从不出现在 src/ 的源码里</b>。
  // 而 Tailwind 是静态扫描源码找类名的 —— 扫不到就不生成 CSS，
  // 结果是卡片结构是对的、样式全无（曾经自检结果卡的四个维度竖着堆成一片）。
  //
  // 这个坑很隐蔽：pages 里自己写的组件样式都正常，只有"服务端渲染后下发"的
  // 那几张卡偏偏没样式，很容易被误判成"React 渲染没生效"。
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './server/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        /*
         * 色阶全部指向 CSS 变量（见 src/index.css）。
         *
         * 为什么不直接写 hex：深色模式需要整站换色，而全站有 560+ 处 gray、
         * 90 处 bg-white。逐处加 dark: 变体既写不完也维护不了，
         * 而在 .dark 下覆盖 .bg-white 这类类名会和 hover:bg-* 打平特异性、
         * 把 hover 吃掉。让"色阶本身"由变量驱动，是唯一不需要改动调用点的做法。
         *
         * 浅色下变量值就是原来的 hex —— 除首页外应当<b>像素级不变</b>。
         * 注意变量必须是 "R G B" 三元组：bg-brand-50/40 这类透明度修饰
         * 依赖 <alpha-value>，存 hex 字符串会让它们全部失效。
         */
        gray: {
          50: 'rgb(var(--gray-50) / <alpha-value>)',
          100: 'rgb(var(--gray-100) / <alpha-value>)',
          200: 'rgb(var(--gray-200) / <alpha-value>)',
          300: 'rgb(var(--gray-300) / <alpha-value>)',
          400: 'rgb(var(--gray-400) / <alpha-value>)',
          500: 'rgb(var(--gray-500) / <alpha-value>)',
          600: 'rgb(var(--gray-600) / <alpha-value>)',
          700: 'rgb(var(--gray-700) / <alpha-value>)',
          800: 'rgb(var(--gray-800) / <alpha-value>)',
          900: 'rgb(var(--gray-900) / <alpha-value>)',
        },

        // 视觉基调：医疗场景用青绿而非蓝。
        // 蓝是"科技感"，但医疗里蓝已经和"挂号 App"绑定；
        // 青绿（teal）更接近"健康/平静"，且与警告红形成清晰对比。
        brand: {
          50: 'rgb(var(--brand-50) / <alpha-value>)',
          100: 'rgb(var(--brand-100) / <alpha-value>)',
          200: 'rgb(var(--brand-200) / <alpha-value>)',
          300: 'rgb(var(--brand-300) / <alpha-value>)',
          400: 'rgb(var(--brand-400) / <alpha-value>)',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
          800: 'rgb(var(--brand-800) / <alpha-value>)',
          900: 'rgb(var(--brand-900) / <alpha-value>)',
        },

        // 下面几套语义色在深色下同样需要反色，否则浅色底块会变成"夜里的一盏灯"
        amber: {
          50: 'rgb(var(--amber-50) / <alpha-value>)',
          100: 'rgb(var(--amber-100) / <alpha-value>)',
          200: 'rgb(var(--amber-200) / <alpha-value>)',
          300: 'rgb(var(--amber-300) / <alpha-value>)',
          400: 'rgb(var(--amber-400) / <alpha-value>)',
          500: 'rgb(var(--amber-500) / <alpha-value>)',
          600: 'rgb(var(--amber-600) / <alpha-value>)',
          700: 'rgb(var(--amber-700) / <alpha-value>)',
          800: 'rgb(var(--amber-800) / <alpha-value>)',
          900: 'rgb(var(--amber-900) / <alpha-value>)',
        },
        red: {
          50: 'rgb(var(--red-50) / <alpha-value>)',
          200: 'rgb(var(--red-200) / <alpha-value>)',
          500: 'rgb(var(--red-500) / <alpha-value>)',
          600: 'rgb(var(--red-600) / <alpha-value>)',
          700: 'rgb(var(--red-700) / <alpha-value>)',
          900: 'rgb(var(--red-900) / <alpha-value>)',
        },
        green: {
          50: 'rgb(var(--green-50) / <alpha-value>)',
          100: 'rgb(var(--green-100) / <alpha-value>)',
          200: 'rgb(var(--green-200) / <alpha-value>)',
          500: 'rgb(var(--green-500) / <alpha-value>)',
          700: 'rgb(var(--green-700) / <alpha-value>)',
          800: 'rgb(var(--green-800) / <alpha-value>)',
        },
        rose: {
          50: 'rgb(var(--rose-50) / <alpha-value>)',
          100: 'rgb(var(--rose-100) / <alpha-value>)',
          500: 'rgb(var(--rose-500) / <alpha-value>)',
          600: 'rgb(var(--rose-600) / <alpha-value>)',
          700: 'rgb(var(--rose-700) / <alpha-value>)',
        },
        orange: {
          100: 'rgb(var(--orange-100) / <alpha-value>)',
          700: 'rgb(var(--orange-700) / <alpha-value>)',
        },

        /*
         * 语义色 —— 界面里"该不该点、要不要紧"只允许用这几套表达。
         *
         * 之所以要这一层：原来 amber 一个颜色同时表示「缺数据 / 免责 / 安全警告 /
         * 化验异常 / 待确认」五件事，患者看多了就全都不看了 ——
         * 重点不突出不是因为颜色不够多，是因为颜色没有分工。
         *
         * soft=浅底  line=描边  DEFAULT=文字  solid=实心块
         */
        surface: 'rgb(var(--surface) / <alpha-value>)', // 卡片面（原 bg-white）
        action: {
          DEFAULT: 'rgb(var(--action) / <alpha-value>)', // 主按钮底（原 bg-brand-700）
          hover: 'rgb(var(--action-hover) / <alpha-value>)',
        },
        ink: {
          strong: 'rgb(var(--ink-strong) / <alpha-value>)', // 深色实心标签的底
        },

        // 预约：时间是全站最需要"一眼看到"的信息，给它一个独立于提醒的蓝
        appt: {
          soft: 'rgb(var(--appt-soft) / <alpha-value>)',
          line: 'rgb(var(--appt-line) / <alpha-value>)',
          DEFAULT: 'rgb(var(--appt) / <alpha-value>)',
          solid: 'rgb(var(--appt-solid) / <alpha-value>)',
        },
        // 重要提醒：复查到期、空腹禁食、用药冲突。琥珀只留给"真的该做点什么"
        alert: {
          soft: 'rgb(var(--alert-soft) / <alpha-value>)',
          line: 'rgb(var(--alert-line) / <alpha-value>)',
          DEFAULT: 'rgb(var(--alert) / <alpha-value>)',
          solid: 'rgb(var(--alert-solid) / <alpha-value>)',
        },
        // 临床异常：化验值超参考范围。和"提醒"分开 —— 异常是事实，提醒是行动
        clinical: {
          soft: 'rgb(var(--clinical-soft) / <alpha-value>)',
          line: 'rgb(var(--clinical-line) / <alpha-value>)',
          DEFAULT: 'rgb(var(--clinical) / <alpha-value>)',
          solid: 'rgb(var(--clinical-solid) / <alpha-value>)',
        },
        // 急症红线：唯一允许高饱和红的地方
        critical: {
          soft: 'rgb(var(--critical-soft) / <alpha-value>)',
          line: 'rgb(var(--critical-line) / <alpha-value>)',
          DEFAULT: 'rgb(var(--critical) / <alpha-value>)',
          solid: 'rgb(var(--critical-solid) / <alpha-value>)',
        },
        // 完成：已服用、已签到、在有效期内
        done: {
          soft: 'rgb(var(--done-soft) / <alpha-value>)',
          line: 'rgb(var(--done-line) / <alpha-value>)',
          DEFAULT: 'rgb(var(--done) / <alpha-value>)',
          solid: 'rgb(var(--done-solid) / <alpha-value>)',
        },
        // 中性说明：免责、缺数据、"这块我们还不知道"。是未知，不是危险，所以不是黄
        neutral: {
          soft: 'rgb(var(--neutral-soft) / <alpha-value>)',
          line: 'rgb(var(--neutral-line) / <alpha-value>)',
          DEFAULT: 'rgb(var(--neutral) / <alpha-value>)',
        },
      },

      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'Source Han Sans SC',
          'Noto Sans CJK SC',
          'sans-serif',
        ],
        /*
         * 只给首页那个「Hi」用。
         *
         * 衬线斜体是这版页面里唯一一处"非医疗"的笔触 —— 它让第一屏
         * 看起来像在跟人打招呼，而不是又一张表。全站其他地方一律 sans：
         * 中文衬线在小字号下发糊，正文用它会直接伤害可读性。
         */
        serif: ['Georgia', '"Times New Roman"', '"Songti SC"', 'serif'],
      },

      /*
       * 阴影只做两档，且都是"绿灰"而不是纯黑。
       * 纯黑阴影压在薄荷底上会发脏；带一点点青的灰反而更像纸的厚度。
       */
      boxShadow: {
        card: '0 1px 2px rgb(16 40 40 / 0.04), 0 6px 16px -12px rgb(16 40 40 / 0.18)',
        lift: '0 10px 30px -14px rgb(16 40 40 / 0.26), 0 1px 2px rgb(16 40 40 / 0.05)',
      },

      // 中文行高比拉丁文字需要更大，1.6 是中文正文的舒适区
      lineHeight: {
        relaxed: '1.7',
      },

      /*
       * 小字号用 rem 而不是 [10px]/[11px]。
       *
       * 适老字号（useTextScale）改的是根字号，px 不参与换算 ——
       * 原来 33 处 px 字在"特大"档里仍然和芝麻一样大，
       * 挑这个功能的人恰恰最需要它们变大。
       */
      fontSize: {
        '3xs': ['0.625rem', { lineHeight: '1rem' }],
        '2xs': ['0.6875rem', { lineHeight: '1.125rem' }],
      },

      keyframes: {
        // 位移从 6px 降到 4px：大卡片整体上浮 6px 会显得"跳"
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
      animation: {
        'fade-up': 'fade-up 220ms ease-out both',
        'fade-in': 'fade-in 180ms ease-out both',
      },
      transitionTimingFunction: {
        'out-soft': 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};
