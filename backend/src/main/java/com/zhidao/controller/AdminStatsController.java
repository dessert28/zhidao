package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.service.AdminStatsService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 管理端 · 数据图表。
 *
 * <p>四个端点对应管理首页的四块内容：概览卡片、预约趋势折线、
 * 科室分布条形、角色占比饼图。前端按接口名一一对应，
 * 拼装逻辑留在前端（图表库不同，数据形状需求不同）。
 *
 * <p>返回值里的中文一律不在这里翻译：科室名来自数据库，
 * 角色名直接用英文枚举。服务端返回展示文案会把多语言、
 * 文案调整都变成后端发版。
 */
@RestController
@RequestMapping("/api/admin/stats")
@RequiredArgsConstructor
public class AdminStatsController {

    private final AdminStatsService statsService;

    /**
     * 概览。
     *
     * <p>{@code hospitalCode} 可选：不传 = 全部院区汇总，传了 = 该院区视角。
     * <b>不是权限参数</b>，只是一个展示口径 —— 谁能调这个接口由
     * {@code SecurityConfig} 的 {@code hasRole("ADMIN")} 决定，
     * 与院区无关（当前设计里管理员是平台级角色，没有归属院区）。
     */
    @GetMapping("/overview")
    public ApiResult<AdminStatsService.Overview> overview(
            @RequestParam(required = false) String hospitalCode) {
        return ApiResult.ok(statsService.overview(hospitalCode));
    }

    /**
     * 近 N 天预约趋势。
     *
     * <p>默认 14 天：一周太短，看不出"周末门诊少"这种规律；
     * 一个月在这个宽度里刻度会挤在一起。
     */
    @GetMapping("/bookings-trend")
    public ApiResult<List<AdminStatsService.TrendPoint>> bookingsTrend(
            @RequestParam(defaultValue = "14") int days,
            @RequestParam(required = false) String hospitalCode) {
        return ApiResult.ok(statsService.bookingsTrend(days, hospitalCode));
    }

    @GetMapping("/departments")
    public ApiResult<List<AdminStatsService.NameValue>> departments(
            @RequestParam(required = false) String hospitalCode) {
        return ApiResult.ok(statsService.departments(hospitalCode));
    }

    /**
     * 角色分布<b>没有</b> hospitalCode 参数：用户表不记院区。
     * 接一个会被忽略的参数，前端就会以为筛选生效了。口径说明见 Service。
     */
    @GetMapping("/roles")
    public ApiResult<List<AdminStatsService.NameValue>> roles() {
        return ApiResult.ok(statsService.roles());
    }
}
