/* ------------------------------------------------------------------
 * 生成式 UI 组件字典 —— D7 的核心机制
 * 依据：docs/10-技术决策-补充.md D7
 *
 * 为什么自己实现而不用 streamUI：
 *   Vercel AI SDK 的 streamUI 依赖 React Server Components，
 *   而 Vite SPA 没有 RSC 运行时，硬接会带来一条无谓的服务端渲染链路。
 *
 * 实现方式（三步）：
 *   1. 事件进入 → 按 type 查 COMPONENT_REGISTRY 找到对应 React 组件
 *   2. 服务端 renderToString() 成 HTML 字符串
 *   3. 随 SSE 一起下发 { type:'ui', html, props }
 *
 * 客户端两条渲染路径共用同一个 EventRenderer：
 *   - 纯展示卡片：直接 dangerouslySetInnerHTML 用 html（快，无 hydration）
 *   - 可交互卡片：按 type 用 props 本地重渲染（有状态、能点）
 * 所以**事件永远同时带 props 和 html**，不是二选一。
 * ------------------------------------------------------------------ */

import { createElement, Fragment, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import type {
  Department,
  RedFlag,
  ReviewerPayload,
  Source,
  TimelineTask,
} from '@shared/types/contract';

/* ============================ 卡片组件 ============================ */

interface DepartmentCardProps {
  departments: ReadonlyArray<Department>;
}

/**
 * 科室推荐卡。展示三件事：科室名、为什么是这个科、置信度。
 * 「为什么」这一行是可解释性的实体 —— 不是装饰。
 */
export function DepartmentCard({ departments }: DepartmentCardProps) {
  if (departments.length === 0) {
    return createElement(
      'div',
      { className: 'rounded-lg border border-gray-200 p-4 text-sm text-gray-500' },
      '暂时无法判断建议科室，请到门诊导诊台咨询。',
    );
  }

  return createElement(
    'div',
    { className: 'rounded-xl border border-gray-200 divide-y divide-gray-100' },
    ...departments.map((d, i) =>
      createElement(
        'div',
        { key: d.name, className: 'flex items-start gap-3 p-4' },
        createElement(
          'span',
          {
            className:
              'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ' +
              (i === 0 ? 'bg-action text-white' : 'bg-gray-100 text-gray-600'),
          },
          String(i + 1),
        ),
        createElement(
          'div',
          { className: 'min-w-0 flex-1' },
          createElement(
            'div',
            { className: 'flex items-center gap-2' },
            createElement('span', { className: 'font-medium text-gray-900' }, d.name),
            i === 0
              ? createElement(
                  'span',
                  {
                    className:
                      'rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-700',
                  },
                  '首选',
                )
              : null,
          ),
          createElement('p', { className: 'mt-1 text-sm text-gray-500' }, d.reason),
        ),
        createElement(
          'span',
          { className: 'shrink-0 text-xs tabular-nums text-gray-400' },
          `${Math.round(d.confidence * 100)}%`,
        ),
      ),
    ),
  );
}

interface EmergencyCardProps {
  redFlag: RedFlag;
}

/** 红线类型 → 中文标题。标题要短且不含诊断，只描述表现。 */
const RED_FLAG_LABEL: Record<RedFlag['type'], string> = {
  chest_pain: '胸痛 · 需立即处理',
  stroke: '疑似卒中 · 需立即处理',
  dyspnea: '呼吸困难 · 需立即处理',
  consciousness: '意识改变 · 需立即处理',
  hemorrhage: '大量出血 · 需立即处理',
};

/**
 * 急诊警示卡。
 *
 * 视觉上刻意不"温和" —— 这是唯一一处该用高饱和红色的地方。
 * 医疗产品里红色泛滥会让真正的急救提示失效，所以红只留给这里。
 */
export function EmergencyCard({ redFlag }: EmergencyCardProps) {
  return createElement(
    'div',
    { className: 'rounded-xl border-2 border-red-500 bg-red-50 p-4' },
    createElement(
      'div',
      { className: 'flex items-center gap-2' },
      createElement('span', { className: 'text-lg', 'aria-hidden': 'true' }, '🚨'),
      createElement(
        'span',
        { className: 'text-base font-semibold text-red-700' },
        RED_FLAG_LABEL[redFlag.type],
      ),
    ),
    createElement(
      'p',
      { className: 'mt-2 text-sm leading-relaxed text-red-900' },
      redFlag.guidance,
    ),
  );
}

interface CaveatCardProps {
  text: string;
}

/**
 * 免责与出处说明条。
 *
 * 中性灰虚线，不是琥珀。
 * "这条依据可能不足"是**我们不确定**，不是"患者有危险" ——
 * 染成警告色之后，患者会把免责声明和"空腹抽血别吃饭"读成同一类东西，
 * 结果是两件都跳过。虚线是"未知"的视觉语汇，正好对应这类内容。
 */
export function CaveatCard({ text }: CaveatCardProps) {
  return createElement(
    'div',
    {
      className:
        'rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-sm leading-relaxed text-gray-600',
    },
    text,
  );
}

interface TimelineCardProps {
  tasks: ReadonlyArray<TimelineTask>;
}

/**
 * 就诊时间轴卡。三段式（去之前 / 在院内 / 回家后）是这个项目的核心叙事，
 * 所以用横向阶段条而不是列表 —— 一眼看到"我现在在哪一段"。
 *
 * 契约里的 TimelineTask 是 order/task/dependsOn/note，
 * 阶段归属暂由 order 推断（1-3 去之前，4-6 在院内，7+ 回家后），
 * 后续 Scheduler 会补显式 phase 字段。
 */
export function TimelineCard({ tasks }: TimelineCardProps) {
  const phases = ['去之前', '在院内', '回家后'] as const;
  const sorted = [...tasks].sort((a, b) => a.order - b.order);

  return createElement(
    'div',
    { className: 'rounded-xl border border-gray-200 p-4' },
    createElement(
      'div',
      { className: 'mb-3 flex items-center gap-1' },
      ...phases.map((p, i) =>
        createElement(
          'div',
          { key: p, className: 'flex items-center gap-1' },
          createElement(
            'span',
            {
              className:
                'rounded px-2 py-0.5 text-xs ' +
                (i === 0 ? 'bg-action text-white' : 'bg-gray-100 text-gray-500'),
            },
            p,
          ),
          i < phases.length - 1
            ? createElement('span', { className: 'text-gray-300' }, '›')
            : null,
        ),
      ),
    ),
    createElement(
      'ol',
      { className: 'space-y-2' },
      ...sorted.map((t) =>
        createElement(
          'li',
          { key: t.order, className: 'flex items-start gap-2 text-sm' },
          createElement(
            'span',
            {
              className:
                'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-medium text-brand-700',
            },
            String(t.order),
          ),
          createElement(
            'div',
            { className: 'min-w-0' },
            createElement('span', { className: 'text-gray-800' }, t.task),
            t.note
              ? createElement(
                  'span',
                  { className: 'ml-1 text-xs text-gray-400' },
                  `（${t.note}）`,
                )
              : null,
          ),
        ),
      ),
    ),
  );
}

interface ReviewTraceProps {
  scores: ReviewerPayload['scores'];
  action: 'pass' | 'retry';
}

/**
 * 审查轨迹卡。四个维度 + 是否回退。
 *
 * 这张卡是"AI 安全与可控性 4%"最直观的证据：
 * 评委能亲眼看到 AI 在给自己打分，而且有一项不及格就会重来。
 */
export function ReviewTraceCard({ scores, action }: ReviewTraceProps) {
  const dims: Array<[string, number]> = [
    ['安全', scores.safety],
    ['准确', scores.accuracy],
    ['完整', scores.completeness],
    ['依据', scores.groundedness],
  ];

  return createElement(
    'div',
    { className: 'rounded-lg border border-gray-200 bg-gray-50 p-3' },
    createElement(
      'div',
      { className: 'mb-2 flex items-center justify-between' },
      createElement('span', { className: 'text-xs font-medium text-gray-600' }, '自检结果'),
      createElement(
        'span',
        {
          className:
            'rounded px-1.5 py-0.5 text-xs ' +
            (action === 'pass'
              ? 'bg-green-100 text-green-700'
              : 'bg-orange-100 text-orange-700'),
        },
        action === 'pass' ? '通过' : '重试',
      ),
    ),
    createElement(
      'div',
      { className: 'grid grid-cols-4 gap-2' },
      ...dims.map(([name, v]) =>
        createElement(
          'div',
          { key: name },
          createElement('div', { className: 'text-xs text-gray-500' }, name),
          createElement(
            'div',
            { className: 'flex items-baseline gap-1' },
            createElement(
              'span',
              {
                className:
                  'text-sm font-medium tabular-nums ' +
                  (v >= 0.6 ? 'text-gray-800' : 'text-red-600'),
              },
              v.toFixed(2),
            ),
          ),
          createElement(
            'div',
            { className: 'mt-1 h-1 w-full overflow-hidden rounded bg-gray-200' },
            createElement('div', {
              className: 'h-full ' + (v >= 0.6 ? 'bg-brand-500' : 'bg-red-500'),
              style: { width: `${Math.round(v * 100)}%` },
            }),
          ),
        ),
      ),
    ),
  );
}

/* ============================ 字典 ============================ */

/**
 * 引用来源卡。
 *
 * 这是 RAG 里最能被评审直接看见的部分 —— 「AI 说的这句话从哪来」。
 * 所以刻意做成可展开的列表，标注来源与相关度，
 * 而不是塞一行小字脚注。
 *
 * 分数用条形长度表示，因为具体数字对患者没有意义，
 * 但"这几篇里哪篇更相关"有意义。
 */
export function SourcesCard({ sources, lowEvidence }: SourcesCardProps) {
  if (sources.length === 0) return null;

  return createElement(
    'div',
    { className: 'rounded-xl border border-gray-200 bg-surface p-4' },
    createElement(
      'div',
      { className: 'mb-2.5 flex items-center gap-2' },
      createElement(
        'span',
        { className: 'text-xs font-medium text-gray-600' },
        `依据 ${sources.length} 篇资料`,
      ),
      lowEvidence
        ? createElement(
            'span',
            { className: 'rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700' },
            '资料较少',
          )
        : null,
    ),
    createElement(
      'ol',
      { className: 'space-y-2' },
      ...sources.map((s, i) =>
        createElement(
          'li',
          { key: s.docId, className: 'flex gap-2.5' },
          createElement(
            'span',
            {
              className:
                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded bg-gray-100 text-3xs font-medium text-gray-500',
            },
            String(i + 1),
          ),
          createElement(
            'div',
            { className: 'min-w-0 flex-1' },
            createElement(
              'div',
              { className: 'flex items-baseline gap-2' },
              createElement('span', { className: 'text-sm text-gray-800' }, s.title),
              // 相关度条：宽度映射 score，避免让患者读无意义的数字
              // 注意用 style 对象而不是字符串 —— React 会拒绝 CSS 字符串
              // 并抛异常，而异常被 renderEventToHtml 吞掉后表现为"卡片没渲染"
              createElement(
                'span',
                { className: 'ml-auto h-1 w-12 shrink-0 rounded bg-gray-100' },
                createElement('span', {
                  className: 'block h-1 rounded bg-brand-500',
                  style: { width: `${Math.round(s.score * 100)}%` },
                }),
              ),
            ),
            createElement(
              'p',
              { className: 'mt-0.5 line-clamp-2 text-xs leading-relaxed text-gray-500' },
              s.snippet,
            ),
          ),
        ),
      ),
    ),
  );
}

/* ============================ 注册表 ============================ */

interface SourcesCardProps {
  sources: Source[];
  lowEvidence?: boolean;
}

/**
 * 事件类型 → 渲染器。
 *
 * 无状态（纯展示）的卡片在这里渲染成 HTML 下发；
 * 有交互的部分（按钮、输入）不在服务端渲染，客户端按 props 接管。
 */
export const COMPONENT_REGISTRY = {
  department_card: (props: { departments: Department[] }) =>
    createElement(DepartmentCard, { departments: props.departments }),

  emergency: (props: { redFlag: RedFlag }) =>
    createElement(EmergencyCard, { redFlag: props.redFlag }),

  caveat: (props: { text: string }) => createElement(CaveatCard, { text: props.text }),

  timeline_card: (props: { tasks: TimelineTask[] }) =>
    createElement(TimelineCard, { tasks: props.tasks }),

  review_trace: (props: { scores: ReviewerPayload['scores']; action: 'pass' | 'retry' }) =>
    createElement(ReviewTraceCard, { scores: props.scores, action: props.action }),

  /**
   * 引用卡挂在 tool_result 上。
   * 只有 hybrid_search 的结果才有 sources，其它工具返回会被
   * SourcesCard 内部的空数组判断挡掉。
   *
   * 注意：不满足条件时返回 createElement(Fragment) 而不是 null ——
   * renderToString(null) 会抛异常，enrich 捕获后就会退回无 html 的原事件，
   * 结果是"该渲染却什么都没渲染"。返回空 fragment 渲染成空串，
   * renderEventToHtml 会把空串当无卡片处理，语义更清楚。
   */
  tool_result: (props: { result?: unknown }) => {
    const r = props.result as { sources?: Source[] } | undefined;
    if (!r?.sources || !Array.isArray(r.sources) || r.sources.length === 0) {
      return createElement(Fragment, null);
    }
    return createElement(SourcesCard, { sources: r.sources });
  },
} as const;

export type RenderableEventType = keyof typeof COMPONENT_REGISTRY;

export function isRenderable(type: string): type is RenderableEventType {
  return type in COMPONENT_REGISTRY;
}

/**
 * 把一个事件渲染成 HTML 字符串。
 *
 * 渲染失败不抛出 —— 生成式 UI 是加分项，不该因为它挂掉整条 SSE。
 * 失败时返回 null，客户端退化为纯文本展示。
 */
export function renderEventToHtml(
  type: string,
  props: Record<string, unknown>,
): string | null {
  if (!isRenderable(type)) return null;
  try {
    // 这里的双断言是必要的：每条渲染器的 props 类型不同，
    // 而分发处只有 string + 不定形状的 props。类型安全由 isRenderable 守住。
    const registry = COMPONENT_REGISTRY as unknown as Record<
      string,
      (p: Record<string, unknown>) => ReactElement
    >;
    const render = registry[type];
    if (!render) return null;
    return renderToString(render(props));
  } catch {
    return null;
  }
}
