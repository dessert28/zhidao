package com.zhidao.controller;

import com.zhidao.adapter.HospitalAdapter;
import com.zhidao.adapter.HospitalAdapterRegistry;
import com.zhidao.common.ApiResult;
import com.zhidao.dto.BookingRequest;
import com.zhidao.entity.BookingOrder;
import com.zhidao.security.CurrentUser;
import com.zhidao.service.BookingService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
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
