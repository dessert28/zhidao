/* ------------------------------------------------------------------
 * Chart —— ECharts 的最小封装
 *
 * ============ 为什么要包一层 ============
 *
 * echarts 是命令式的：一个 DOM 节点对应一个实例，实例自己管 canvas、
 * 自己管 resize。直接塞进 React 组件里，最容易踩的两个坑是
 * "每次渲染 new 一个实例"和"卸载后实例还挂在 DOM 上继续监听"。
 * 这一层把 init / setOption / resize / dispose 固定成四条线。
 *
 * ============ StrictMode 下 effect 会跑两次 ============
 *
 * React 18 开发模式会 mount → unmount → mount。第一次的 cleanup 已经
 * dispose 了实例，如果第二次直接 setOption，会拿到一个已销毁的实例
 * （控制台报 "Instance ... has been disposed"）。所以：
 *   · 复用：先 getInstanceByDom，有就接着用，避免重复 init
 *   · 幂等：dispose 前先查 isDisposed()
 * 线上（无 StrictMode）这套写法同样成立，不需要环境判断。
 *
 * ============ 为什么依赖里只有 option ============
 *
 * height 变化由 CSS 处理（容器是同一块 DOM），只需要 ResizeObserver
 * 触发 resize()，不需要重建实例 —— 把 height 放进依赖会让每次改高度
 * 都 dispose 再 init，动画会闪。
 * ------------------------------------------------------------------ */

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export interface ChartProps {
  option: echarts.EChartsOption;
  /** 容器高度（px），默认 220 —— 大约是一张卡片 + 一行说明的高度 */
  height?: number;
  className?: string;
}

export function Chart({ option, height = 220, className }: ChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /*
   * 实例放在 ref 里而不是 effect 内的局部变量：
   * 两个 effect 要共用同一个实例 —— 一个负责生死，一个负责数据。
   * 拆成两段的原因见下方注释，不能合并。
   */
  const chartRef = useRef<echarts.ECharts | null>(null);

  /*
   * 生与死：只在挂载/卸载时跑。
   *
   * 之前这两件事和数据更新挤在同一个 effect 里，后果是 option 一变
   * React 会先跑 cleanup → dispose 掉实例 → 再重新 init。
   * 表面上也能出图，但每次刷新数据都是"销毁重建"：
   *   · 过渡动画丢失（ECharts 的动画依赖同一个实例的旧状态）
   *   · canvas 尺寸重算，图表会闪一下
   * 拆开之后，数据变化只走 setOption，实例从头到尾只有一个。
   */
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    // 复用优先：StrictMode 下第一次 cleanup 已 dispose，注册表里不会有残留，
    // 但万一有人在同一节点上挂了别的实例，这里也不会打架
    const chart = echarts.getInstanceByDom(el) ?? echarts.init(el);
    chartRef.current = chart;

    const observer = new ResizeObserver(() => {
      // 容器宽度变了（旋转屏幕、侧栏展开）才 resize；disposed 后调用会抛错
      if (!chart.isDisposed()) chart.resize();
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      if (!chart.isDisposed()) chart.dispose();
      chartRef.current = null;
    };
  }, []);

  /*
   * 数据：option 变了就重设，实例不动。
   * notMerge = true —— 数据从 14 天切到 7 天时，旧的类别轴刻度必须清掉，
   * 否则 y 轴会留着一串没有数据的科室名。
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || chart.isDisposed()) return;
    chart.setOption(option, true);
  }, [option]);

  return <div ref={hostRef} style={{ height }} className={className} />;
}

export default Chart;
