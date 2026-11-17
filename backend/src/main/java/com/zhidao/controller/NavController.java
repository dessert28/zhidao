package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.entity.HospitalPlace;
import com.zhidao.security.CurrentUser;
import com.zhidao.service.HospitalNavService;
import com.zhidao.service.VisitProgressService;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.ArrayList;
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
    private final VisitProgressService progressService;

    /**
     * 某院区某科室的分步路线。
     *
     * <p>不需要登录：患者到院后打开就能看，不要求先登录 ——
     * 这一步本来就是"最着急的时刻"，多一次登录就是多一次流失。
     *
     * <p><b>带上 bookingId 时</b>会叠加该单的手动进度（见
     * {@link VisitProgressService}）：患者标记过"检验已完成"，
     * 那么即使按时间还没到，那一步也显示成 DONE，并且
     * CURRENT 顺延到下一步。不带 bookingId 就纯按时间推算 ——
     * 匿名访问拿不到任何人的进度，这也是不登录能安全开放的原因。
     */
    @GetMapping("/route")
    public ApiResult<Map<String, Object>> route(
            @RequestParam String hospitalCode,
            @RequestParam String department,
            @RequestParam(defaultValue = "false") boolean needsFasting,
            @RequestParam(defaultValue = "false") boolean examOnlyAfterDoctor,
            @RequestParam(required = false)
            @DateTimeFormat(iso = DateTimeFormat.ISO.DATE_TIME) LocalDateTime visitTime,
            @RequestParam(required = false) Long bookingId) {

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

        /*
         * 叠加患者自己标的进度。
         *
         * <p>只有带了 bookingId 且请求方是登录用户时才做 ——
         * 进度是"我的"数据，匿名访问不该被别人的标记影响。
         * 这里用 try 包住 CurrentUser.id()：导航本身允许匿名，
         * 没登录时它可能抛异常，那种情况下静默跳过叠加即可。
         */
        Map<String, String> marks = Map.of();
        if (bookingId != null) {
            try {
                marks = progressService.progressOf(CurrentUser.id(), bookingId);
            } catch (RuntimeException ignored) {
                // 未登录 / token 失效：保持纯时间推算，不影响导航可用性
            }
        }
        steps = applyProgress(steps, marks);

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

    /**
     * 把患者手动标记的进度叠加到时间推算的结果上。
     *
     * <p>三条规则，都有具体理由：
     *
     * <ol>
     *   <li><b>标记优先于时间推算。</b>患者说检验做完了，即使按时间
     *       还没到，也标 DONE —— 他站在窗口前，比任何推算都准。</li>
     *   <li><b>CURRENT 顺延到第一个没被标记的步骤。</b>
     *       否则会出现"第 1 步已完成后，第 2 步还是 UPCOMING"，
     *       患者看到的是"没有一步告诉我现在去哪"，比不标记更糟。</li>
     *   <li><b>SKIPPED 也算"不需要再去了"</b>，但不显示成已完成 ——
     *       界面要区分"做过"和"跳过"，否则回看时会以为那项检查做过。</li>
     * </ol>
     *
     * <p>nav_key 的生成规则必须与前端一致：有科室的用 `阶段:科室`，
     * 没科室的只用阶段编码。两边不一致会导致标记了却不生效。
     */
    private List<HospitalNavService.RouteStep> applyProgress(
            List<HospitalNavService.RouteStep> steps,
            Map<String, String> marks) {

        if (marks.isEmpty()) return steps;

        List<HospitalNavService.RouteStep> out = new ArrayList<>(steps.size());
        boolean currentAssigned = false;

        for (HospitalNavService.RouteStep s : steps) {
            String key = navKeyOf(s);
            String mark = marks.get(key);

            String status;
            if (mark != null) {
                // 标记过：DONE / SKIPPED 都算"这步不用再去了"
                status = mark;
            } else if (!currentAssigned) {
                /*
                 * 第一个没被标记的步骤，就是"现在该去"的那一步。
                 *
                 * <p><b>这里不能沿用时间推算的 status。</b>第一版写的是
                 * `"CURRENT".equals(s.status()) ? "CURRENT" : s.status()`，
                 * 结果实测出问题：预约在几天后时，时间推算把所有步骤都算成
                 * "已过"，于是 currentIdx 落到最后一步（药房）。
                 * 患者标记完第 1 步，CURRENT 直接跳到了药房 ——
                 * 中间四步全被跳过，而他明明还在挂号窗口。
                 *
                 * <p>正确的语义：只要有任何一步被标记，就说明患者正在
                 * 按顺序走流程，"现在"就是他还没走过的最前一步。
                 */
                status = "CURRENT";
                currentAssigned = true;
            } else {
                status = "UPCOMING";
            }

            out.add(new HospitalNavService.RouteStep(
                    s.order(), s.stage(), s.stageLabel(), s.place(), status, s.note()));
        }

        /*
         * 边界：全部标完了，就没有 CURRENT 了。
         * 这时把最后一步标成 CURRENT 而不是留空 —— 患者全做完还在页面里，
         * 看到"没有下一步"会以为出错了；指向最后一步（通常是取药）
         * 至少给出一个合理的落点。
         */
        if (out.stream().noneMatch(s -> "CURRENT".equals(s.status())) && !out.isEmpty()) {
            int last = out.size() - 1;
            HospitalNavService.RouteStep s = out.get(last);
            if ("UPCOMING".equals(s.status())) {
                out.set(last, new HospitalNavService.RouteStep(
                        s.order(), s.stage(), s.stageLabel(), s.place(), "CURRENT", s.note()));
            }
        }

        return out;
    }

    /**
     * 生成步骤的稳定标识。前端必须用同一套规则。
     *
     * <p>有科室的步骤（诊区）加科室后缀：同一院区不同科的路线
     * 可能共用同一批地点，只按阶段编码会让两个科室的标记载重。
     */
    static String navKeyOf(HospitalNavService.RouteStep s) {
        String dept = s.place().getDepartment();
        return (dept == null || dept.isBlank()) ? s.stage() : s.stage() + ":" + dept;
    }
}
