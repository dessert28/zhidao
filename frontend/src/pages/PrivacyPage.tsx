/* ------------------------------------------------------------------
 * 隐私与脱敏 —— 讲清数据到底怎么流动
 *
 * ============ 为什么单独一页 ============
 * 原先「我的」页叫「隐私与脱敏」的入口指向 /records（病历页），
 * 但病历页只管"上传和查看"，脱敏说明散落在上传卡片和页脚的两句话里。
 * 点进去的人想看的是"我的信息会不会被传走"，看到的却是文件列表 ——
 * 标题承诺的和实际内容对不上。
 *
 * 这一页只做一件事：把端侧脱敏这条链路摊开给人看。
 * 法律文本（隐私政策/用户协议）是后端下发的另一份东西，页尾给入口，
 * 两者不混 —— 一个是"技术上怎么做"，一个是"条款上怎么约定"。
 * ------------------------------------------------------------------ */

import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionTitle } from '../components/ui/SectionTitle';
import { PrivacySection } from '../components/PrivacySection';
import { CheckIcon, LockIcon } from '../components/ui/icons';

/** 与 lib/privacy/redact.ts 的 PiiType 一一对应，别在这页另造分类 */
const PII_ITEMS = [
  { label: '身份证号', how: '保留前 4 位与后 4 位，中间 10 位打码' },
  { label: '手机号', how: '保留前 3 位与后 4 位，中间打成 ****' },
  { label: '银行卡号', how: '16–19 位连续数字，保留首尾各 4 位' },
  { label: '病历号 / 就诊卡号', how: '整段替换为「病历号已遮蔽」' },
  { label: '邮箱', how: '保留用户名前 2 位，域名保留' },
  { label: '住址', how: '省市区 + 街道门牌整段替换为「住址已遮蔽」' },
];

/** 数据都放在哪。API Key 那行刻意不美化 —— 见 SettingsPage 顶部说明 */
const STORAGE_ITEMS = [
  {
    where: '病历原文',
    place: '这台设备的浏览器（IndexedDB）',
    note: '换设备不同步；服务端没有存原文的字段',
  },
  {
    where: '登录凭证',
    place: '本次会话（sessionStorage）',
    note: '关掉标签页即失效，共享电脑更安全',
  },
  {
    where: '模型 API Key',
    place: '这台设备的浏览器（localStorage）',
    note: '能打开这个浏览器的人都可能看到，仅适合演示/自用',
  },
];

const FLOW = [
  { n: '1', title: '读取文件', detail: 'PDF / 图片在你设备上解析' },
  { n: '2', title: '端侧脱敏', detail: '规则引擎遮掉证件号、手机号等' },
  { n: '3', title: '只发摘要', detail: '传给服务端的只有脱敏后的文本' },
  { n: '4', title: '不留原文', detail: '数据库里没有存原文的字段' },
];

export default function PrivacyPage() {
  return (
    <div className="pb-4">
      <PageHeader
        eyebrow="隐私与脱敏"
        title="你的信息，去哪儿了"
        subtitle="一句话：病历原文不离开这台设备。"
      />

      {/* 核心承诺。用品牌色实心卡而不是 Callout —— 这是陈述事实，不是"未知"或"警告" */}
      <section className="mt-5 rounded-2xl border border-brand-200 bg-brand-50 p-4">
        <div className="flex items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white">
            <LockIcon size={17} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-brand-900">原文不出设备</h2>
            <p className="mt-1 text-xs leading-relaxed text-brand-800">
              脱敏发生在你的浏览器里，而不是服务器上。原文如果先上传到服务端再脱敏，
              传输和日志里就已经留下痕迹 —— 那样说"保护隐私"是没有意义的。
            </p>
          </div>
        </div>

        <ol className="mt-4 grid gap-2 sm:grid-cols-2">
          {FLOW.map((s) => (
            <li key={s.n} className="flex items-start gap-2 rounded-xl bg-surface/80 px-3 py-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-100 text-2xs font-semibold tabular-nums text-brand-800">
                {s.n}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-gray-900">{s.title}</span>
                <span className="mt-0.5 block text-2xs leading-relaxed text-gray-600">
                  {s.detail}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-6">
        <SectionTitle>会遮蔽哪些信息</SectionTitle>
        <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-surface shadow-card">
          {PII_ITEMS.map((p) => (
            <div
              key={p.label}
              className="flex flex-col gap-0.5 border-b border-gray-100 px-3.5 py-2.5 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-3"
            >
              <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-gray-900">
                <CheckIcon size={13} className="text-brand-600" />
                {p.label}
              </span>
              <span className="text-2xs leading-relaxed text-gray-600 sm:ml-auto sm:text-right">
                {p.how}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 px-1 text-2xs leading-relaxed text-gray-500">
          原则是"宁可多遮蔽，不可漏遮蔽"：多遮一个词只是读起来别扭，漏掉一个手机号是真的泄漏。
          上传前会有预览，能直接看到遮掉了哪些内容。
        </p>
      </section>

      <section className="mt-6">
        <SectionTitle>数据存在哪里</SectionTitle>
        <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-surface shadow-card">
          {STORAGE_ITEMS.map((s) => (
            <div key={s.where} className="border-b border-gray-100 px-3.5 py-3 last:border-b-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-gray-900">{s.where}</span>
                <span className="text-2xs text-gray-500">{s.place}</span>
              </div>
              <p className="mt-1 text-2xs leading-relaxed text-gray-600">{s.note}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 授权记录：复用病历页已有的组件，避免两处各写一套后端调用 */}
      <div className="mt-6">
        <PrivacySection />
      </div>

      <div className="mt-6 rounded-2xl border border-gray-200/80 bg-surface px-3.5 py-3">
        <p className="text-xs leading-relaxed text-gray-600">
          本页说明技术上怎么保护数据。法律条款见
          <Link to="/legal/privacy" className="mx-1 font-medium text-brand-700 hover:underline">
            《隐私政策》
          </Link>
          与
          <Link to="/legal/terms" className="mx-1 font-medium text-brand-700 hover:underline">
            《用户协议》
          </Link>
          （未登录也能打开）。
        </p>
      </div>
    </div>
  );
}
