/** @type {import('tailwindcss').Config} */
export default {
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
        // 视觉基调：医疗场景用青绿而非蓝。
        // 蓝是"科技感"，但医疗里蓝已经和"挂号 App"绑定；
        // 青绿（teal）更接近"健康/平静"，且与警告红形成清晰对比。
        brand: {
          50: '#f0fdfa',
          100: '#ccfbf1',
          200: '#99f6e4',
          300: '#5eead4',
          400: '#2dd4bf',
          500: '#14b8a6',
          600: '#0d9488',
          700: '#0f766e',
          800: '#115e59',
          900: '#134e4a',
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
      },
      // 中文行高比拉丁文字需要更大，1.6 是中文正文的舒适区
      lineHeight: {
        relaxed: '1.7',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 220ms ease-out both',
      },
    },
  },
  plugins: [],
};
