package com.zhidao.controller;

import com.zhidao.adapter.HospitalAdapter;
import com.zhidao.adapter.HospitalAdapterRegistry;
import com.zhidao.adapter.HospitalIntegrationContract;
import com.zhidao.common.ApiResult;
import com.zhidao.dto.BookingRequest;
import com.zhidao.entity.BookingOrder;
import com.zhidao.security.CurrentUser;
import com.zhidao.service.BookingService;
import com.zhidao.service.HospitalNavService;
import com.zhidao.service.QueueEstimateService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 预约接口。
 *
 * <p>号源查询与建单是两条路径：
 * <ul>
 *   <li>{@code /slots} 只是<b>看一眼</b>，不落库，号源永远是院方的实时数据</li>
 *   <li>{@code POST /} 才真的下单，且必须先在院方成功才写我们的库</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/bookings")
@RequiredArgsConstructor
public class BookingController {

    private final BookingService bookingService;
    private final HospitalAdapterRegistry adapters;
    private final HospitalNavService navService;
    private final QueueEstimateService queueService;

    /** 已接入的院区编码。前端渲染下拉框用，省得硬编码 */
    @GetMapping("/hospitals")
    public ApiResult<List<String>> hospitals() {
        return ApiResult.ok(adapters.codes());
    }

    /**
     * 院区目录：编码 + 展示名 + 开设科室。
     *
     * <p>与 {@code /hospitals} 的区别：那个只给编码，前端还得自己维护一张
     * 「编码 → 中文名」的映射表（`lib/api.ts` 的 {@code hospitalName}）。
     * 那张表每加一家院区就会漏一次，漏了界面上就直接显示 "Z2-JFL"。
     * 现在名字由院方侧给出，前端不再持有第二份真相。
     */
    @GetMapping("/hospitals/catalog")
    public ApiResult<List<Map<String, Object>>> hospitalCatalog() {
        return ApiResult.ok(adapters.catalogs());
    }

    /**
     * 院方接入清单（字段级）。
     *
     * <p>给医院信息科看：照着这份清单准备数据，接入就是实现一个
     * {@code HospitalAdapter} 类。刻意做成公开接口而不是写进内部文档 ——
     * 对接方拿不到我们的仓库。
     */
    @GetMapping("/integration-contract")
    public ApiResult<List<Map<String, String>>> integrationContract() {
        return ApiResult.ok(HospitalAdapterRegistry.integrationRequirements());
    }

    /**
     * 院方接入契约（接口级，完整版）。
     *
     * <p>与 {@code /integration-contract} 的区别：那个是"要实现哪些方法"，
     * 这个是"每个端点长什么样"—— 路径、参数、响应结构、错误码、
     * 以及一组联调自查请求。院方把它当接口文档读。
     *
     * <p>放在接口里而不是只写进 md：契约与
     * {@link com.zhidao.adapter.HospitalIntegrationContract} 一起编译，
     * 接口改了文档忘改这件事就不容易发生了。
     */
    @GetMapping("/integration-spec")
    public ApiResult<Map<String, Object>> integrationSpec() {
        return ApiResult.ok(HospitalIntegrationContract.describe());
    }

    /**
     * 联调自查清单。
     *
     * <p>院方实现完 4 个端点后照着打一遍，能覆盖「有号 / 没号 / 号满 /
     * 重复提交」四类最容易出错的情况。单独一个端点是因为它比契约本身
     * 短得多，联调时反复看的只有它。
     */
    @GetMapping("/integration-smoke-tests")
    public ApiResult<List<Map<String, Object>>> integrationSmokeTests() {
        return ApiResult.ok(HospitalIntegrationContract.smokeTests());
    }

    @GetMapping("/slots")
    public ApiResult<List<Map<String, Object>>> slots(
            @RequestParam String hospitalCode,
            @RequestParam String department,
            @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {

        List<HospitalAdapter.Slot> slots = bookingService.querySlots(hospitalCode, department, date);
        List<Map<String, Object>> data = slots.stream().map(s -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("visitTime", s.visitTime());
            m.put("doctorName", s.doctorName());
            m.put("remaining", s.remaining());
            return m;
        }).toList();
        return ApiResult.ok(data);
    }

    @GetMapping
    public ApiResult<List<BookingOrder>> list() {
        return ApiResult.ok(bookingService.list(CurrentUser.id()));
    }

    /**
     * 排队估算 —— 「我还要等多久」。
     *
     * <p>需要登录：这是"我的某一单"的排队情况，属于个人信息。
     * 与院内导航不同 —— 导航是院方公开信息（楼层索引牌上就有）。
     *
     * <p>返回里带 {@code disclaimer}，前端必须一起展示。
     * 这是估算不是院方实时叫号，说得太肯定会让患者误事。
     */
    @GetMapping("/{id}/queue")
    public ApiResult<Map<String, Object>> queue(@PathVariable long id) {
        BookingOrder order = bookingService.get(CurrentUser.id(), id);
        LocalDateTime now = LocalDateTime.now();

        /*
         * 单人耗时优先用院内地点里配的实际值（该科室诊区的 estMinutes），
         * 查不到再用服务里的默认 15 分钟。
         * 这样院方改了自己的看诊节奏，估算会跟着变，不用改代码。
         */
        int minutesPerPatient = navService
                .placesFor(order.getHospitalCode(), order.getDepartment()).stream()
                .filter(p -> "CLINIC".equals(p.getPlaceType()))
                .map(p -> p.getEstMinutes() == null ? 0 : p.getEstMinutes())
                .filter(m -> m > 0)
                .findFirst()
                .orElse(0);

        QueueEstimateService.Estimate est =
                queueService.estimate(order, minutesPerPatient, now);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("orderId", order.getId());
        data.put("hospitalCode", order.getHospitalCode());
        data.put("department", order.getDepartment());
        data.put("visitTime", order.getVisitTime());
        data.put("status", order.getStatus());
        data.put("estimate", est);
        /*
         * minutesPerPatient 一并返回：患者看到"按每人 60 分钟估算"时，
         * 能理解为什么数字这么大（内分泌科配的就是 60），
         * 而不是觉得系统的数字莫名其妙。
         */
        data.put("minutesPerPatient",
                minutesPerPatient > 0 ? minutesPerPatient : 15);
        data.put("now", now);
        return ApiResult.ok(data);
    }

    @GetMapping("/{id}")
    public ApiResult<BookingOrder> get(@PathVariable long id) {
        return ApiResult.ok(bookingService.get(CurrentUser.id(), id));
    }

    @PostMapping
    public ApiResult<BookingOrder> create(@Valid @RequestBody BookingRequest req) {
        return ApiResult.ok(bookingService.create(CurrentUser.id(), req));
    }

    @PostMapping("/{id}/confirm")
    public ApiResult<BookingOrder> confirm(@PathVariable long id) {
        return ApiResult.ok(bookingService.changeStatus(CurrentUser.id(), id, BookingOrder.STATUS_CONFIRMED));
    }

    /**
     * 患者自助签到："我已到院"。
     *
     * <p><b>必须说清它不是什么</b>：它只在我们自己的库里记一个时间点，
     * 不调用院方系统，也不代表院方那里已经报到。真正的签到
     * 还是要在自助机或分诊台完成。界面文案必须写明这一点 ——
     * 让患者以为点一下就不用去机器上刷，是这里最容易造成的伤害。
     *
     * <p><b>幂等</b>：重复点击只记第一次的时间。
     * 患者在大厅里等得无聊多点两下很常见，每次都刷新时间会让
     * 排队估算来回跳。
     *
     * <p>为什么不限制必须临近就诊才允许签到：患者可能早到一小时，
     * 也可能提前一天来问路。限制时间点只会制造"点了没反应"。
     * 真正该限制的是取消，不是签到。
     */
    @PostMapping("/{id}/checkin")
    public ApiResult<BookingOrder> checkin(@PathVariable long id) {
        return ApiResult.ok(bookingService.checkIn(CurrentUser.id(), id));
    }

    /**
     * 取消。
     *
     * <p><b>先过政策，再过状态机。</b>顺序有意义：
     * 距就诊不足 24 小时的号不该退，这是业务规则；
     * 而"能不能取消"是状态机管的另一件事。先问政策，
     * 患者看到的是「需要到窗口办理」而不是一句冷冰冰的
     * 「当前状态不能变成已取消」。
     */
    @PostMapping("/{id}/cancel")
    public ApiResult<BookingOrder> cancel(@PathVariable long id) {
        BookingOrder order = bookingService.get(CurrentUser.id(), id);

        String blocked = com.zhidao.service.CancelPolicy.blockedReason(order, LocalDateTime.now());
        if (blocked != null) {
            throw new com.zhidao.common.BizException(40903, blocked);
        }

        return ApiResult.ok(bookingService.changeStatus(CurrentUser.id(), id, BookingOrder.STATUS_CANCELLED));
    }

    /**
     * 我还能不能退这个号。
     *
     * <p>单独一个查询接口而不是让前端自己算 24 小时：
     * 规则一变（改成 12 小时、或某院特殊政策），前端就得跟着改一次。
     * 规则只在后端有一份，前端只负责显示。
     */
    @GetMapping("/{id}/cancel-policy")
    public ApiResult<Map<String, Object>> cancelPolicy(@PathVariable long id) {
        BookingOrder order = bookingService.get(CurrentUser.id(), id);
        LocalDateTime now = LocalDateTime.now();
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("canCancel", com.zhidao.service.CancelPolicy.blockedReason(order, now) == null);
        data.put("reason", com.zhidao.service.CancelPolicy.blockedReason(order, now));
        data.put("deadline", com.zhidao.service.CancelPolicy.deadlineOf(order));
        return ApiResult.ok(data);
    }

    @PostMapping("/{id}/complete")
    public ApiResult<BookingOrder> complete(@PathVariable long id) {
        return ApiResult.ok(bookingService.changeStatus(CurrentUser.id(), id, BookingOrder.STATUS_COMPLETED));
    }
}
