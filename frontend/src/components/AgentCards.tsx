/* ------------------------------------------------------------------
 * 纯展示型 Agent 卡片 —— 客户端渲染版
 *
 * 背景：这套卡片原本由 BFF 用 React renderToString 生成 html，
 * 随 SSE 一起下发（docs/10 D7「生成式 UI」）。AI 能力迁到 Spring Boot 之后，
 * Java 侧没有 React 运行时，AgentEvent.html 从来不会被填，
 * 而 EventRenderer 旧逻辑是「没有 html 就 return null」——
 * 结果是科室卡、急症卡、免责条全部静默消失，只剩一段 token 文字。
 *
 * 现在的策略：**html 优先，缺失则用这里本地渲染**。
 * 两条路径产出同一个视觉，谁先到用谁：
 *   - 有 html（旧 BFF / 将来 Java 若补渲染）→ 直接注入，首帧快；
 *   - 无 html（当前 Java 后端）→ 用本地组件，零额外网络、可被单测覆盖。
 *
 * 为什么不改成「Java 拼 HTML 字符串」：
 * 样式要写两遍（前端改色、后端也要改），还得自己保证转义 —— 把渲染留在
 * 前端，样式只有一份，文本仍由 React 转义，反而更安全。
 * ------------------------------------------------------------------ */

import type { Department, RedFlag } from '@shared/types/contract';

/* ============================ 科室推荐卡 ============================ */

/**
 * 科室推荐卡。展示三件事：科室名、为什么是这个科、置信度。
 * 「为什么」这一行是可解释性的实体 —— 不是装饰。
 */
export function DepartmentCard({ departments }: { departments: ReadonlyArray<Department> }) {
  if (departments.length === 0) {
    return (
      <div className="animate-fade-up rounded-lg border border-gray-200 p-4 text-sm text-gray-500">
        暂时无法判断建议科室，请到门诊导诊台咨询。
      </div>
    );
  }

  return (
    <div className="animate-fade-up divide-y divide-gray-100 rounded-xl border border-gray-200">
      {departments.map((d, i) => (
        <div key={d.name} className="flex items-start gap-3 p-4">
          <span
            className={
              'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ' +
              (i === 0 ? 'bg-action text-white' : 'bg-gray-100 text-gray-600')
            }
          >
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-gray-900">{d.name}</span>
              {i === 0 && (
                <span className="rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-700">首选</span>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-500">{d.reason}</p>
          </div>
          <span className="shrink-0 text-xs tabular-nums text-gray-400">
            {Math.round(d.confidence * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}

/* ============================ 急诊警示卡 ============================ */

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
export function EmergencyCard({ redFlag }: { redFlag: RedFlag }) {
  return (
    <div className="animate-fade-up rounded-xl border-2 border-red-500 bg-red-50 p-4">
      <div className="flex items-center gap-2">
        <span className="text-lg" aria-hidden="true">
          🚨
        </span>
        <span className="text-base font-semibold text-red-700">
          {RED_FLAG_LABEL[redFlag.type] ?? '需要立即处理'}
        </span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-red-900">{redFlag.guidance}</p>
    </div>
  );
}

/* ============================ 免责说明条 ============================ */

/**
 * 免责与出处说明条。
 *
 * 中性灰虚线，不是琥珀。
 * "这条依据可能不足"是**我们不确定**，不是"患者有危险" ——
 * 染成警告色之后，患者会把免责声明和"空腹抽血别吃饭"读成同一类东西，
 * 结果是两件都跳过。虚线是"未知"的视觉语汇，正好对应这类内容。
 */
export function CaveatCard({ text }: { text: string }) {
  return (
    <div className="animate-fade-up rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-sm leading-relaxed text-gray-600">
      {text}
    </div>
  );
}
