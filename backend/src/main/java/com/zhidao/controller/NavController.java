package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.entity.HospitalPlace;
import com.zhidao.service.HospitalNavService;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 院内导航接口 —— 「在院内」那一段。
 *
 * <p>与预约接口分开：预约是"来之前"的事，导航是"到了之后"的事，
 * 两者的调用时机与权限都不同（导航不需要登录，患者到院后才用）。
 */
@RestController
@RequestMapping("/api/nav")
@RequiredArgsConstructor
public class NavController {

    private final HospitalNavService navService;

    /**
     * 某院区某科室的分步路线。
     *
     * <p>不需要登录：患者到院后打开就能看，不要求先登录 ——
     * 这一步本来就是"最着急的时刻"，多一次登录就是多一次流失。
     */
    @GetMapping("/route")
    public ApiResult<Map<String, Object>> route(
            @RequestParam String hospitalCode,
            @RequestParam String department,
            @RequestParam(defaultValue = "false") boolean needsFasting,
            @RequestParam(defaultValue = "false") boolean examOnlyAfterDoctor,
            @RequestParam(required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) LocalDateTime visitTime) {

        LocalDateTime now = LocalDateTime.now();
        /*
         * 没传 visitTime 时给一个合理默认：今天已经过了 9 点就按明天 9:00 算。
         *
         * 为什么需要默认值：路线要标"哪步已完成/哪步该去"，
         * 没有锚点就只能瞎标。但直接报错又会让"只想看看这家医院长什么样"
         * 的调用方用不了 —— 给一个默认锚点，两种需求都满足。
         */
        LocalDateTime anchor = visitTime != null
                ? visitTime
                : (now.toLocalTime().isAfter(java.time.LocalTime.of(9, 0))
                    ? now.toLocalDate().plusDays(1).atTime(9, 0)
                    : now.toLocalDate().atTime(9, 0));

        List<HospitalNavService.RouteStep> steps =
                navService.buildRoute(hospitalCode, department, needsFasting, examOnlyAfterDoctor, anchor, now);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("hospitalCode", hospitalCode);
        data.put("department", department);
        data.put("steps", steps);
        data.put("totalMinutes", totalMinutes(steps));
        data.put("visitTime", anchor);
        /*
         * dataQuality：路线里只要有一条是示意数据，整体就标示意。
         * 这个字段会一路传到前端界面 —— 不能让患者把示意楼层当成真的。
         */
        data.put("dataQuality", steps.stream()
                .anyMatch(s -> !"REAL".equals(s.place().getDataQuality())) ? "SAMPLE" : "REAL");
        data.put("generatedAt", now);
        return ApiResult.ok(data);
    }

    /**
     * 现在该去哪一步。
     *
     * <p>给"实时提醒"用：前端隔一段时间问一次，或者用户点"下一步去哪"。
     */
    @GetMapping("/current")
    public ApiResult<Map<String, Object>> current(
            @RequestParam String hospitalCode,
            @RequestParam String department,
            @RequestParam(defaultValue = "false") boolean needsFasting,
            @RequestParam
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) LocalDateTime visitTime) {

        LocalDateTime now = LocalDateTime.now();
        var step = navService.currentStep(hospitalCode, department, needsFasting, visitTime, now);

        Map<String, Object> data = new LinkedHashMap<>();
        if (step.isEmpty()) {
            data.put("hasStep", false);
            data.put("message", "这个院区还没有配置导航地点，可以到一楼服务台问路。");
        } else {
            HospitalNavService.RouteStep s = step.get();
            data.put("hasStep", true);
            data.put("step", s);
            /*
             * 顺便提示"可能已关门"：患者跑到窗口发现关门，比没给导航更糟。
             * 用粗判（只比对结束时间），宁可多提示一句。
             */
            data.put("maybeClosed", HospitalNavService.maybeClosed(s.place(), now));
        }
        data.put("now", now);
        return ApiResult.ok(data);
    }

    /**
     * 某院区的全部地点。
     *
     * <p>给"院区一览"用，也方便排查"这家医院到底配了哪些数据"。
     */
    @GetMapping("/places")
    public ApiResult<List<HospitalPlace>> places(@RequestParam String hospitalCode) {
        return ApiResult.ok(navService.listByHospital(hospitalCode));
    }

    private int totalMinutes(List<HospitalNavService.RouteStep> steps) {
        return steps.stream()
                .map(HospitalNavService.RouteStep::place)
                .map(HospitalPlace::getEstMinutes)
                .filter(java.util.Objects::nonNull)
                .mapToInt(Integer::intValue)
                .sum();
    }
}
