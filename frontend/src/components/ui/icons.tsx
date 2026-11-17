/* ------------------------------------------------------------------
 * 图标集
 *
 * ============ 为什么不装图标库 ============
 *
 * 全站用到的图标不到 20 个，而且尺寸只有 15/17/20 三种。
 * lucide-react 虽然 tree-shake 后只留下用到的几个，但它每个图标都带
 * 自己的 defaultProps 与包装函数 —— 第一屏为了 6 个小图形多一个
 * 网络请求，在"打开就要看到今天吃什么药"的场景里不划算。
 *
 * 这里每个图标都是一条 <path>，共用一个 <Icon> 壳：
 * 尺寸、线宽、圆头端点只在一处定义，改一处全站一致。
 *
 * ============ 线宽为什么分两档 ============
 *
 * 15–20px 的小图标用 1.9：2 会把细笔画（日历的挂钩、叶子的尖）糊死。
 * 箭头类用 2.2–2.4：它们只有两三条线，太细会在卡片边缘消失。
 * ------------------------------------------------------------------ */

import type { ReactNode, SVGProps } from 'react';

export interface IconProps
  extends Omit<SVGProps<SVGSVGElement>, 'children' | 'strokeWidth'> {
  size?: number;
  /**
   * 线宽收窄为 number。
   *
   * <p>必须从 SVGProps 里 Omit 掉再重定义：SVGProps 的 strokeWidth 是
   * `string | number`，直接继承会与本组件的数值计算（按尺寸分两档）冲突，
   * @types/react 升到 18.3.3x 后这一处会直接报 TS2322。
   */
  strokeWidth?: number;
}

function Icon({
  size = 16,
  strokeWidth = 1.9,
  children,
  ...rest
}: IconProps & { children: ReactNode; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 报告解读：一页带折角的纸 */
export function ReportIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </Icon>
  );
}

/** 问诊：对话气泡 */
export function ChatIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.5A8 8 0 1 1 21 12z" />
    </Icon>
  );
}

/** 挂号：带勾的日历 */
export function CalendarCheckIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M8 3v4M16 3v4M3 11h18" />
      <path d="M9 16l2 2 4-4" />
    </Icon>
  );
}

/** 到院：定位针 */
export function PinIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.4" />
    </Icon>
  );
}

/** 健康管家：心 */
export function HeartIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 0 0-7.1 7.1L12 21.5l8.8-8.8a5 5 0 0 0 0-7.1z" />
    </Icon>
  );
}

/** 就诊摘要：一页纸 */
export function SheetIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M4 5h16v14H4z" />
      <path d="M8 9h8M8 13h5" />
    </Icon>
  );
}

/** 病历：文件 */
export function RecordsIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </Icon>
  );
}

/** 模型接口：滑杆 */
export function SlidersIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="9" cy="7" r="2" fill="currentColor" fillOpacity="0" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="8" cy="17" r="2" />
    </Icon>
  );
}

/** 隐私：锁 */
export function LockIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="4" y="10" width="16" height="11" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

/** 字号 */
export function TypeIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M4 19V7h8M8 19V7M14 19v-7h6M17 12v7" />
    </Icon>
  );
}

export function SunIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Icon>
  );
}

export function MoonIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </Icon>
  );
}

export function GearIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  );
}

/** 右箭头（"去这里"） */
export function ArrowRightIcon(p: IconProps) {
  return (
    <Icon strokeWidth={2.3} {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  );
}

/** 右尖括号（列表项尾部） */
export function ChevronRightIcon(p: IconProps) {
  return (
    <Icon strokeWidth={2.2} {...p}>
      <path d="M9 6l6 6-6 6" />
    </Icon>
  );
}

/** 左尖括号（返回上一级） */
export function ChevronLeftIcon(p: IconProps) {
  return (
    <Icon strokeWidth={2.2} {...p}>
      <path d="M15 6l-6 6 6 6" />
    </Icon>
  );
}

/** 麦克风 —— 悬浮问句条的左侧。 */
export function MicIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="8" y="2" width="8" height="12" rx="4" />
      <path d="M4 12a8 8 0 0 0 16 0M12 20v2" />
    </Icon>
  );
}

export function PlusIcon(p: IconProps) {
  return (
    <Icon strokeWidth={2.2} {...p}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function SendIcon(p: IconProps) {
  return (
    <Icon strokeWidth={2} {...p}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Icon>
  );
}
