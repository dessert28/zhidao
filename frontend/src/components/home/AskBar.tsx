/* ------------------------------------------------------------------
 * 悬浮的「问一句」
 *
 * ============ 它为什么必须常驻 ============
 *
 * 这一页讲的是"今天吃什么药、还要准备什么"，都是**答案**。
 * 但患者看到答案之后最常冒出来的是一句话的问题 ——
 * 「这个药能和降压药一起吃吗」「头晕该挂什么科」。
 * 如果入口是顶部导航里的「问诊」，他得先退出当前这屏、丢掉上下文。
 *
 * 所以它是一个常驻在拇指热区的入口，点了就带着这屏的上下文去问。
 *
 * ============ 为什么是 <Link> 而不是输入框 ============
 *
 * 真输入框意味着首页要背上对话组件（端侧脱敏模型、流式渲染、
 * 消息持久化）。那是问诊页的职责。这里的定位是"把你送到能问的地方"，
 * 一句话都不假装能答 —— 假输入框点进去什么都发不出去，比没有更糟。
 *
 * 内部不再嵌 <button>：一个可点区域里套按钮，屏幕阅读器会读成两个控件。
 * ------------------------------------------------------------------ */

import { Link } from 'react-router-dom';
import { MicIcon, PlusIcon, SendIcon } from '../ui/icons';

export function AskBar() {
  return (
    /*
      底部固定条。
      外面这层渐变不是为了好看：没有它，滚动时内容会在条的边缘
      被"一刀切断"，看着像页面坏了。渐变让文字自然淡出到背景。
      两侧留 16px 与内容区对齐。
    */
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-10 bg-gradient-to-t from-gray-50 via-gray-50/92 to-transparent px-4 pb-3.5 pt-6">
      <Link
        to="/chat"
        aria-label="去问诊：把今天的情况告诉 AI 导诊助手"
        className="pointer-events-auto mx-auto flex max-w-[640px] items-center gap-2.5 rounded-full border border-gray-200/70 bg-surface py-2 pl-4 pr-2 shadow-lift"
      >
        <span className="text-brand-600">
          <MicIcon size={19} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-gray-400">
          问问今天该注意什么
        </span>
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gray-200 text-gray-500"
        >
          <PlusIcon size={13} />
        </span>
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-white"
        >
          <SendIcon size={16} />
        </span>
      </Link>
    </div>
  );
}

export default AskBar;
