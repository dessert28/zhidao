package com.zhidao.controller;

import com.zhidao.adapter.HospitalAdapter;
import com.zhidao.adapter.HospitalAdapterRegistry;
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

    /** 已接入的院区列表。前端渲染下拉框用，省得硬编码 */
    @GetMapping("/hospitals")
    public ApiResult<List<String>> hospitals() {
        return ApiResult.ok(adapters.codes());
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

    /** 取消是幂等语义上的"结果一致"，但不允许把已取消的单再取消一次（会重复调院方） */
    @PostMapping("/{id}/cancel")
    public ApiResult<BookingOrder> cancel(@PathVariable long id) {
        return ApiResult.ok(bookingService.changeStatus(CurrentUser.id(), id, BookingOrder.STATUS_CANCELLED));
    }

    @PostMapping("/{id}/complete")
    public ApiResult<BookingOrder> complete(@PathVariable long id) {
        return ApiResult.ok(bookingService.changeStatus(CurrentUser.id(), id, BookingOrder.STATUS_COMPLETED));
    }
}
