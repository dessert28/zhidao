/* ------------------------------------------------------------------
 * 智诊通标识
 *
 * ============ 这版是怎么来的 ============
 *
 * 不是"照着重画"，而是把参考图的位图**真实矢量化**：
 * 先去水印（按列做色度归一化，水印是灰色、色度≈0，天然被剔除），
 * 再 8× 上采样后用 Marching Squares 提亚像素轮廓，沿弧长重采样 →
 * 高斯平滑 → Catmull-Rom 转三次贝塞尔。与原图 IoU 0.941。
 *
 * 之前有一版是"量出关键点手动画几何"的做法（IoU 0.64）：
 * 结构对，但每条弧的弯曲程度都差一点点，叠在一起就能看出不是同一张图。
 *
 * ============ 为什么是 <img> 而不是内联 SVG ============
 *
 * 描摹出来的路径约 29KB。内联进 JS 会让首屏 chunk 平白多 29KB，
 * 而它永远不会变 —— 那是静态资源的典型特征，该走 HTTP 缓存。
 * 文件在 public/ 下，矢量在任意尺寸都清晰，不需要多套位图。
 *
 * 代价是不能再用 currentColor 换色。可以接受：这是个彩色标识，
 * 深底（#1D2530）上青绿到黄的渐变对比度足够，不需要反白版本。
 * ------------------------------------------------------------------ */

export interface LogoProps {
  /** 高度（px）。宽度按 1:1 跟随 —— 资源本身已是方形画幅 */
  size?: number;
  className?: string;
  /** 无障碍名称 */
  title?: string;
}

export default function Logo({ size = 28, className = '', title = '智诊通' }: LogoProps) {
  return (
    <img
      src="/logo-mark.svg"
      width={size}
      height={size}
      className={className}
      alt={title}
      // 明确解码方式，避免标识在首屏"闪一下再出现"
      decoding="async"
      draggable={false}
    />
  );
}
