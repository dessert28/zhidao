/* ------------------------------------------------------------------
 * 错误边界 —— 一个页面崩了，不能让整个应用白屏
 *
 * ============ 为什么必须有 ============
 *
 * React 18 里任何一个渲染期异常都会让整棵树卸载 —— 用户看到的是
 * 一片白。对医疗产品来说这尤其糟：患者可能正在看「今天吃什么药」
 * 或者「到院去哪」，一屏白等于什么都没告诉他。
 *
 * 错误边界把崩溃范围限制在**路由层级**：一个页面炸了，
 * 顶栏、导航、其他页面都还在，用户能自己走到别处。
 *
 * ============ 为什么错误信息不展示给用户 ============
 *
 * 生产环境的堆栈可能包含内部路径、接口地址，甚至（如果谁不小心
 * 往 message 里拼了数据）患者信息。所以用户只看到一句
 * 人话 + 一个出口，堆栈只进 console。
 *
 * 这不是"藏起来"，是"给对的人看"：患者需要知道接下来怎么办，
 * 只有开发者需要看 `Cannot read properties of undefined`。
 * ------------------------------------------------------------------ */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface Props {
  /*
   * 可选而不是必填：React Router 的 route.ErrorBoundary 声明为
   * ComponentType<{}>，它会用一个不含 children 的元素渲染我们。
   * 写成必填，类型就对不上（编译器会直接报错）。
   */
  children?: ReactNode;
}

interface State {
  error: Error | null;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    /*
     * 只打错误类型、message 和组件栈。
     * componentStack 里可能有组件名，但不含 props 值 ——
     * 这一点很重要：props 里可能是病历数据。
     */
    console.error(
      '[route-error]',
      error.name,
      error.message,
      info.componentStack?.split('\n').slice(0, 5).join(' '),
    );
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="py-16 text-center">
        <div className="text-sm font-medium text-gray-800">这个页面没能显示出来</div>
        <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-gray-500">
          问题出在这一页，其他功能不受影响。可以回上一页，或者直接回到首页。
          如果你正在看病途中，请以医院现场指引为准。
        </p>

        <div className="mt-5 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-lg border border-gray-200 bg-surface px-4 py-2 text-sm text-gray-700"
          >
            重试
          </button>
          <Link
            to="/"
            className="rounded-lg bg-action px-4 py-2 text-sm font-medium text-white"
          >
            回到今日
          </Link>
        </div>

        {/*
          急救入口。页面崩了不代表患者没有急症 ——
          错误页里仍然要保留 120 提示，这是医疗产品的底线。
        */}
        <p className="mt-6 text-xs text-red-600">如有胸痛、呼吸困难、意识不清等急症，请立即拨打 120。</p>
      </div>
    );
  }
}
