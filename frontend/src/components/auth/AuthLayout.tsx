/* ------------------------------------------------------------------
 * 登录 / 注册共用外壳
 *
 * ============ 为什么不做成 App 的子路由 ============
 * 登录、注册是"还没进入系统"的状态，顶栏那五个导航项和一个设置齿轮
 * 对此时的人没有意义，反而会分散注意力。所以这两个页面挂在根路由下、
 * 与 App 平级，不带主导航与页脚免责声明（品牌区下方保留一行即可）。
 *
 * ============ 表单项为什么要抽成 TextField ============
 * 登录和注册加起来有 6 个输入框，手写六遍"标签 + 输入框 + 错误文案"
 * 的骨架，六处都可能出现 focus 样式不一致。抽一层之后，视觉只在这里
 * 定义一次，页面里只剩业务字段。
 * ------------------------------------------------------------------ */

import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Logo from '../ui/Logo';
import { CheckIcon } from '../ui/icons';
import type { AgreementLink } from '../../lib/auth/agreements';
import { cn } from '../../lib/utils';

export interface AuthLayoutProps {
  /** 卡片标题，如「登录」「注册账号」 */
  title: string;
  /** 标题下方的一行说明 */
  subtitle?: string;
  /** 表单主体 */
  children: ReactNode;
  /** 卡片底部的跳转区，如"还没有账号？立即注册" */
  footer: ReactNode;
}

export default function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <div className="page-bg flex min-h-dvh flex-col">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-5 py-10">
        {/* 品牌区 */}
        <div className="mb-7 flex flex-col items-center text-center">
          <Logo size={56} title="智诊通标识" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-gray-900">智诊通</h1>
          <p className="mt-1.5 text-sm text-gray-500">让每一次就诊，都从容一点</p>
        </div>

        {/* 表单卡片 */}
        <section className="animate-fade-up rounded-2xl border border-gray-100 bg-surface p-6 shadow-card">
          <header className="mb-6">
            <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
            {subtitle ? <p className="mt-1 text-xs leading-relaxed text-gray-500">{subtitle}</p> : null}
          </header>
          {children}
        </section>

        <div className="mt-6 text-center text-sm text-gray-500">{footer}</div>
      </div>

      <p className="px-5 pb-6 text-center text-xs leading-relaxed text-gray-400">
        本系统只做信息整理、风险提示与就诊准备，不提供诊断、用药或停药建议。
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'password' | 'tel';
  inputMode?: 'text' | 'tel' | 'numeric';
  autoComplete?: string;
  maxLength?: number;
  /** 左侧小图标 */
  icon?: ReactNode;
  /** 右侧控件，如密码显隐按钮 */
  trailing?: ReactNode;
  /** 校验错误；有值时描边转红并展示文案 */
  error?: string;
  disabled?: boolean;
}

export function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  inputMode,
  autoComplete,
  maxLength,
  icon,
  trailing,
  error,
  disabled,
}: TextFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-gray-700">
        {label}
      </label>
      <div
        className={cn(
          'flex h-11 items-center gap-2 rounded-lg border bg-gray-50/60 px-3 transition-colors',
          'focus-within:border-brand-400 focus-within:bg-surface focus-within:ring-2 focus-within:ring-brand-100',
          error ? 'border-red-300' : 'border-gray-200',
        )}
      >
        {icon ? <span className="shrink-0 text-gray-400">{icon}</span> : null}
        <input
          id={id}
          name={id}
          type={type}
          inputMode={inputMode}
          autoComplete={autoComplete}
          maxLength={maxLength}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400 disabled:opacity-60"
        />
        {trailing}
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** 主提交按钮：占满宽度，比通用 Button 的 md 更高一档，便于点按 */
export function AuthSubmitButton({
  children,
  disabled,
  onClick,
  type = 'submit',
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: (e: FormEvent) => void;
  type?: 'submit' | 'button';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-action text-sm font-medium text-white transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:bg-gray-300"
    >
      {children}
    </button>
  );
}

/**
 * 演示账号清单。
 *
 * <p>三行等宽对齐、字号压到 2xs：登录卡片在 375px 屏上只剩约 260px 内宽，
 * 一行里塞「角色 + 账号 + 密码」必须靠固定宽度的角色列，否则三行会歪。
 */
const DEMO_ACCOUNTS = [
  { role: '患者', username: 'demo', password: 'demo1234' },
  { role: '医生', username: 'doctor', password: 'demo1234' },
  { role: '管理员', username: 'admin', password: 'demo1234' },
];

/**
 * 演示环境提示条：明确告诉看 demo 的人"不必接后端也能试"，
 * 并且把三种角色的账号一次列全 —— 老师/评委要的是
 * 「一眼看到能用哪些身份进来」，分三次登录去猜账号没有意义。
 *
 * <p>刻意只做文字、不做「一键填入」：点了之后账号框变了、密码框没变，
 * 反而让人以为已经填好，还要先清空再输。提示就是提示。
 */
export function DemoHint({ children }: { children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-xs leading-relaxed text-brand-800">
      {children ? <p className="mb-1 text-2xs text-brand-700">{children}</p> : null}
      <p className="text-2xs font-medium text-brand-700">演示账号（三种角色，密码均为 demo1234）</p>
      <ul className="mt-0.5 space-y-0.5">
        {DEMO_ACCOUNTS.map((a) => (
          <li key={a.username} className="flex items-baseline gap-2">
            <span className="w-12 shrink-0 text-2xs text-brand-700">{a.role}</span>
            <span className="min-w-0 font-medium tabular-nums text-brand-900">
              {a.username} / {a.password}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 用户协议 / 隐私政策勾选。登录、注册共用同一份文案与交互：
 * 同一个合规提示在两页长得不一样，是评审时最容易被挑出来的那种"细节不统一"。
 *
 * 协议名和链接由 agreements 传入（来自 useAgreementLinks），组件不写死任何
 * 协议标题与地址 —— 后续接真实接口时这里一行都不用改。
 *
 * 勾选块和协议链接是并列的：button 里嵌 Link 既是非法 HTML，点链接又会
 * 冒泡把勾选状态翻掉。所以小方块单独做按钮，文字区的链接各自独立。
 */
export function AgreementCheckbox({
  checked,
  onChange,
  agreements,
  error,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  agreements: AgreementLink[];
  error?: string;
}) {
  return (
    <div>
      <div className="flex items-start gap-2 text-xs leading-relaxed text-gray-600">
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label="我已阅读并同意用户协议与隐私政策"
          onClick={() => onChange(!checked)}
          className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
            checked ? 'border-action bg-action text-white' : 'border-gray-300 bg-surface',
          )}
        >
          {checked ? <CheckIcon size={12} /> : null}
        </button>
        <span>
          我已阅读并同意
          {agreements.map((a, i) => (
            <span key={a.id}>
              {i > 0 ? '与' : ''}
              <Link
                to={a.href}
                className="text-brand-700 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                《{a.label}》
              </Link>
            </span>
          ))}
        </span>
      </div>
      {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
