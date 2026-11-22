/* ------------------------------------------------------------------
 * 管理概览 —— 后台的"一屏看全"
 *
 * ============ 布局为什么是"数字 + 三张图" ============
 *
 * 管理员进后台的第一件事不是操作，而是判断"今天有没有异常"。
 * 所以最上面放四个可数的数字（人、院区、预约、病历），下面才放趋势。
 * 图表全部只回答一个问题，不做成可切换的多功能面板 ——
 * 答辩时一屏能讲完，真实使用中也不用点了才看得见。
 *
 * ============ 四个请求分别容错 ============
 *
 * 统计接口走同一条链路，但任何一个挂掉都只影响自己那一块：
 * 概览数字拿不到时图表照样能看，反之亦然。如果共用一个 error 状态，
 * 一个 500 会让整页变成一条红字，管理员会以为整个后台坏了。
 *
 * ============ 院区口径 ============
 *
 * 顶部下拉可以切"全部院区 / 某个院区"。这不是权限，是展示口径：
 * 当前角色体系里管理员是平台级角色，`sys_user` 没有院区字段。
 * 切到单院区时，预约/病历/院内地点按该院区算，而用户与公告仍是全院 ——
 * 这两类数据根本没有院区归属，界面上必须写出来，否则数字会被误读。
 *
 * ============ 配色 ============
 *
 * 全部取项目主色（青绿）的单色阶 + 灰色。不用彩虹色：饼图和柱状图
 * 里的颜色不是为了区分数据，而是为了"深浅表示大小"，
 * 红/黄/紫同时出现会让人误以为有告警等级。
 * ------------------------------------------------------------------ */

import { useEffect, useMemo, useState } from 'react';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import { AdminShell, adminFieldClass } from '../../components/admin/AdminShell';
import { Chart } from '../../components/admin/Chart';
import { Callout } from '../../components/ui/Callout';
import { Card } from '../../components/ui/Card';
import { SectionTitle } from '../../components/ui/SectionTitle';
import { Stat } from '../../components/ui/Stat';
import {
  failureMessage,
  getAdminOverview,
  getBookingTrend,
  getDepartmentStats,
  getRoleStats,
  listAdminHospitals,
  roleLabel,
  type AdminHospital,
  type AdminStatsOverview,
  type StatPoint,
  type TrendPoint,
} from '../../lib/api';

/** 主色阶：brand-600 / brand-500 / brand-300，最后两档留给小类别 */
const BRAND_DEEP = '#0d9488';
const BRAND = '#14b8a6';
const BRAND_LIGHT = '#5eead4';
const GRAY = '#9ca3af';
const GRAY_LIGHT = '#d1d5db';

/** '2026-11-08' → '11-08'。x 轴只要日，年份放进 tooltip 反而占地方 */
function shortDate(iso: string): string {
  return iso.length >= 10 ? iso.slice(5, 10) : iso;
}

export default function AdminDashboardPage() {
  const [overview, setOverview] = useState<AdminStatsOverview | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [departments, setDepartments] = useState<StatPoint[]>([]);
  const [roles, setRoles] = useState<StatPoint[]>([]);

  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [departmentError, setDepartmentError] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  /** 切换院区时的"后台刷新"标记：与首次 loading 分开，免得图表先被"载入中"顶掉再画回来 */
  const [refreshing, setRefreshing] = useState(false);

  /**
   * 统计范围。空串 = 全部院区汇总。
   *
   * 这里刻意不做成"管理员有归属院区、只能看自己的"：`sys_user` 没有院区字段，
   * 当前角色体系里管理员就是平台级角色。这个下拉是**展示口径**，不是权限边界 ——
   * 权限仍然只由后端 `hasRole("ADMIN")` 决定。
   */
  const [scope, setScope] = useState('');
  const [hospitals, setHospitals] = useState<AdminHospital[]>([]);

  // 院区列表只用来填下拉。失败就静默降级成"只有全部院区一个选项"，
  // 不能因为下拉数据拿不到就让整页统计也出不来。
  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await listAdminHospitals({ size: 50 });
      if (!alive || !r.ok) return;
      setHospitals(r.data.records);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // alive 防的是 StrictMode 下卸载后 setState（第二个 mount 会重新发一遍请求）
    let alive = true;
    // 既是首次加载也是切院区：首次才显示"载入中"，之后只显示"更新中"
    setRefreshing(true);

    void (async () => {
      const [ov, tr, dp, ro] = await Promise.all([
        getAdminOverview(scope || undefined),
        getBookingTrend(14, scope || undefined),
        getDepartmentStats(scope || undefined),
        getRoleStats(),
      ]);
      if (!alive) return;

      // 切院区前先清掉上一轮的错误：否则新数据已经成功，红条还挂在那里
      setOverviewError(null);
      setTrendError(null);
      setDepartmentError(null);
      setRoleError(null);

      if (ov.ok) setOverview(ov.data);
      else setOverviewError(failureMessage(ov.failure));

      if (tr.ok) setTrend(tr.data);
      else setTrendError(failureMessage(tr.failure));

      if (dp.ok) setDepartments(dp.data);
      else setDepartmentError(failureMessage(dp.failure));

      if (ro.ok) setRoles(ro.data);
      else setRoleError(failureMessage(ro.failure));

      setLoading(false);
      setRefreshing(false);
    })();

    return () => {
      alive = false;
    };
  }, [scope]);

  const trendOption = useMemo<EChartsOption>(
    () => ({
      grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
      tooltip: { trigger: 'axis' },
      xAxis: {
        type: 'category',
        data: trend.map((p) => shortDate(p.date)),
        axisLine: { lineStyle: { color: GRAY_LIGHT } },
        axisTick: { show: false },
        axisLabel: { color: '#6b7280', fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        splitLine: { lineStyle: { color: '#f3f4f6' } },
        axisLabel: { color: '#9ca3af', fontSize: 10 },
      },
      series: [
        {
          name: '预约数',
          type: 'line',
          smooth: true,
          symbolSize: 5,
          data: trend.map((p) => p.count),
          lineStyle: { width: 2, color: BRAND_DEEP },
          itemStyle: { color: BRAND_DEEP },
          // 渐变而不是平涂：线上方的面积越大，视觉重量越强，
          // 但底部必须透明，否则会和下一条网格线切出一道硬边
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(13, 148, 136, 0.22)' },
              { offset: 1, color: 'rgba(13, 148, 136, 0)' },
            ]),
          },
        },
      ],
    }),
    [trend],
  );

  const departmentOption = useMemo<EChartsOption>(() => {
    // 只取前 8：更多科室会把条形压到 10px 以下，名字和数字都挤不下
    const top = [...departments].sort((a, b) => b.value - a.value).slice(0, 8);
    return {
      grid: { left: 8, right: 32, top: 8, bottom: 4, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: {
        type: 'value',
        minInterval: 1,
        splitLine: { lineStyle: { color: '#f3f4f6' } },
        axisLabel: { color: '#9ca3af', fontSize: 10 },
      },
      yAxis: {
        type: 'category',
        data: top.map((p) => p.name),
        // inverse：ECharts 默认把第一项画在最下面，倒过来才是"最大的在最上面"
        inverse: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#4b5563', fontSize: 11 },
      },
      series: [
        {
          name: '预约数',
          type: 'bar',
          data: top.map((p) => p.value),
          barMaxWidth: 16,
          itemStyle: { color: BRAND, borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: 'right', color: '#6b7280', fontSize: 10 },
        },
      ],
    };
  }, [departments]);

  const roleOption = useMemo<EChartsOption>(
    () => ({
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, itemWidth: 8, itemHeight: 8, textStyle: { color: '#6b7280', fontSize: 11 } },
      series: [
        {
          name: '角色',
          type: 'pie',
          radius: ['46%', '68%'],
          center: ['50%', '44%'],
          itemStyle: { borderColor: '#ffffff', borderWidth: 2 },
          label: { show: false },
          data: roles.map((r, i) => ({
            // name 用中文：图例上出现 PATIENT 对答辩观众没有信息量
            name: roleLabel(r.name),
            value: r.value,
            itemStyle: { color: [BRAND_DEEP, BRAND, BRAND_LIGHT, GRAY][i % 4] ?? GRAY },
          })),
        },
      ],
    }),
    [roles],
  );

  const scopeName = scope
    ? hospitals.find((h) => h.hospitalCode === scope)?.name ?? scope
    : null;

  /**
   * 用户与公告没有院区归属，筛了单院区它们仍是全院数字。
   * 这里必须当场标出来，否则"这个院区有 5 个患者"会被当成事实读走。
   */
  const patientHint = overview
    ? `患者 ${overview.patientCount} · 医生 ${overview.doctorCount} · 管理员 ${overview.adminCount}${
        scope ? '（全院）' : ''
      }`
    : '按角色拆分';

  return (
    <AdminShell
      title="管理概览"
      subtitle={
        scopeName
          ? `${scopeName} · 单院区视角`
          : '全部院区汇总 · 今天院内有多少预约、大家都在看什么科'
      }
    >
      <Card className="mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="stats-scope" className="text-2xs font-medium text-gray-500">
            统计范围
          </label>
          <select
            id="stats-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className={`${adminFieldClass} max-w-[240px]`}
          >
            <option value="">全部院区（汇总）</option>
            {hospitals.map((h) => (
              <option key={h.hospitalCode} value={h.hospitalCode}>
                {h.name} · {h.hospitalCode}
              </option>
            ))}
          </select>
          {refreshing && !loading ? (
            <span className="text-2xs text-gray-400">更新中…</span>
          ) : null}
        </div>
        <p className="mt-2 text-2xs leading-relaxed text-gray-400">
          {scope
            ? '预约、病历、院内地点按该院区统计；用户与公告没有院区归属，仍为全院口径。'
            : '当前是全院汇总，下面每个数字都是各院区相加的结果。'}
        </p>
      </Card>

      {overviewError ? (
        <Callout tone="alert" dense title="统计数字没取到" className="mb-3">
          {overviewError}
        </Callout>
      ) : null}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3">
        <Stat label="用户总数" value={overview ? overview.userCount : '—'} hint={patientHint} />
        <Stat
          label="院区数"
          value={overview ? overview.hospitalCount : '—'}
          hint={overview ? `院内地点 ${overview.placeCount} 个` : '已接入的院区'}
        />
        <Stat
          label="预约总数"
          value={overview ? overview.bookingCount : '—'}
          hint={overview ? `今日新增 ${overview.todayBookingCount}` : '历史累计'}
        />
        <Stat
          label="病历总数"
          value={overview ? overview.recordCount : '—'}
          hint={overview ? `公告 ${overview.noticeCount} 条` : '患者上传与院内同步'}
        />
      </div>

      {/*
        桌面两列、手机单列。
        趋势图和科室分布是"同一层的两个问题"，并排才能一眼对上——
        哪一天预约多、那天主要看的什么科。竖着排要来回滚，等于逼人记数字。
      */}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Card>
          <SectionTitle count={trend.length ? `${trend.length} 天` : undefined}>
            近 14 天预约趋势
          </SectionTitle>
          {trendError ? (
            <Callout tone="neutral" dense>
              {trendError}
            </Callout>
          ) : loading ? (
            <div className="py-12 text-center text-xs text-gray-400">载入中…</div>
          ) : trend.length === 0 ? (
            <div className="py-12 text-center text-xs text-gray-400">这 14 天还没有预约记录</div>
          ) : (
            <Chart option={trendOption} height={220} />
          )}
        </Card>

        <Card>
          <SectionTitle count={departments.length ? `共 ${departments.length} 个科室` : undefined}>
            科室分布 Top8
          </SectionTitle>
          {departmentError ? (
            <Callout tone="neutral" dense>
              {departmentError}
            </Callout>
          ) : loading ? (
            <div className="py-12 text-center text-xs text-gray-400">载入中…</div>
          ) : departments.length === 0 ? (
            <div className="py-12 text-center text-xs text-gray-400">还没有科室维度的预约数据</div>
          ) : (
            <Chart
              option={departmentOption}
              height={Math.max(160, Math.min(8, departments.length) * 32 + 24)}
            />
          )}
        </Card>
      </div>

      <Card className="mt-3">
        <SectionTitle>用户角色分布</SectionTitle>
        {scope ? (
          <p className="mb-1 text-2xs text-gray-400">
            用户不归属院区，此图为全院口径，不随上方筛选变化
          </p>
        ) : null}
        {roleError ? (
          <Callout tone="neutral" dense>
            {roleError}
          </Callout>
        ) : loading ? (
          <div className="py-12 text-center text-xs text-gray-400">载入中…</div>
        ) : roles.length === 0 ? (
          <div className="py-12 text-center text-xs text-gray-400">还没有用户数据</div>
        ) : (
          /*
            宽屏时饼图靠左、说明靠右：一张 240px 高的饼图独占 1152px
            会显得很空，而右边正好能放下"这些数字是怎么算的"。
            窄屏保持上下排，说明文字直接跟在图下面。
          */
          <div className="md:flex md:items-center md:gap-8">
            <div className="md:w-80 md:shrink-0">
              <Chart option={roleOption} height={240} />
            </div>
            <div className="mt-2 space-y-1.5 text-2xs leading-relaxed text-gray-400 md:mt-0 md:flex-1">
              <p>
                角色数字来自 <span className="text-gray-500">sys_user</span> 全表计数，
                已排除逻辑删除的账号。
              </p>
              <p>医生与管理员目前是平台级角色，没有归属院区，因此不受院区筛选影响。</p>
              <p>患者数只统计 role=PATIENT，不含已禁用账号之外的其它状态。</p>
            </div>
          </div>
        )}
      </Card>
    </AdminShell>
  );
}
