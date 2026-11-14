/**
 * className 合并工具。
 *
 * <p>{@code components.json} 已经配好 shadcn/ui 的别名，但要真正用上
 * 后续组件（Button / Dialog …），{@code @/lib/utils} 的 {@code cn()} 必须存在 ——
 * shadcn 生成的每个组件都 import 它。缺了它 {@code npx shadcn add button}
 * 会生成一堆 import 不到的文件，报错信息还指向 node_modules。
 *
 * <p>为什么是 clsx + tailwind-merge 两个库而不是自己拼字符串：
 * 手写 {@code `${a} ${b}`} 在出现冲突类时（{@code px-2} 与 {@code px-4}）结果是
 * CSS 里的先后顺序说了算，而不是调用顺序 —— 调试时非常反直觉。
 * tailwind-merge 会让后者稳定地覆盖前者。
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
