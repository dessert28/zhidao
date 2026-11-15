package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.adapter.HospitalAdapter;
import com.zhidao.adapter.HospitalAdapterRegistry;
import com.zhidao.common.BizException;
import com.zhidao.dto.BookingRequest;
import com.zhidao.entity.BookingOrder;
import com.zhidao.mapper.BookingOrderMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.stream.Collectors;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 预约业务。
 *
 * <p>这个类最值得看的是<b>状态迁移的校验位置</b>：
 * 规则写在 Service 里而不是实体里，因为"能不能从 CREATED 变成 CANCELLED"
 * 是业务判断，不是数据的属性。把状态机塞进实体，等于让每个用到实体的地方
 * 都继承一套它可能不该遵守的规则。
 *
 * <p>另一件事：<b>下单失败不能悄悄吞掉</b>。
 * 院方返回"该时段已满"和"接口超时"是完全不同的两件事 ——
 * 前者让用户换个时间，后者应该重试。所以 {@link HospitalAdapter.BookingResult}
 * 带回了 message，而不是一个 boolean。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class BookingService {

    /** 合法迁移：源状态 -> 允许的目标状态集合 */
    private static final Map<String, Set<String>> TRANSITIONS = Map.of(
            BookingOrder.STATUS_CREATED, Set.of(BookingOrder.STATUS_CONFIRMED, BookingOrder.STATUS_CANCELLED),
            BookingOrder.STATUS_CONFIRMED, Set.of(BookingOrder.STATUS_COMPLETED, BookingOrder.STATUS_CANCELLED),
            BookingOrder.STATUS_COMPLETED, Set.of(),
            BookingOrder.STATUS_CANCELLED, Set.of()
    );

    private final BookingOrderMapper bookingMapper;
    private final HospitalAdapterRegistry adapters;

    /** 查号源：直接问院方适配器，不落库 —— 号源是别人的实时数据 */
    /**
     * 查询号源，并扣减**已被本地预约占用**的数量。
     *
     * <p>为什么要在这里扣：适配器（{@link HospitalAdapter}）代表的是**院方**，
     * 它能说的只是"我们放出了几个号"。而我们本地已经下过的单，
     * 院方适配器并不知道 —— Mock 实现甚至把 remaining 写死成 1。
     *
     * <p>实测缺陷（2026-11-15）：同一时段下单成功后，
     * 再查号源仍然显示 remaining=1，看起来"无限可约"。
     * 虽然重复下单会被 409 拦住，但**展示给用户的数字是错的** ——
     * 患者会以为还有号，点进去才发现被拒。这比没有号更让人困惑。
     *
     * <p>扣减逻辑放在 Service 而不是适配器：
     * 适配器是对院方协议的抽象，不该知道我们的订单表。
     * 一旦把订单查询塞进适配器，换真实院方对接时就要重写一遍。
     *
     * <p>只统计**未取消**的单：CANCELLED 之后号应该回到池子里。
     */
    public List<HospitalAdapter.Slot> querySlots(String hospitalCode, String department, LocalDate date) {
        List<HospitalAdapter.Slot> raw = adapters.of(hospitalCode).querySlots(department, date);
        if (raw.isEmpty()) return raw;

        /*
         * 一次查出这一天该科室所有未取消的订单，在内存里按时间做减。
         * 不逐条 SQL 查：号源通常十几个，逐条查是 N+1。
         */
        LocalDateTime dayStart = date.atStartOfDay();
        LocalDateTime dayEnd = date.plusDays(1).atStartOfDay();

        List<BookingOrder> booked = bookingMapper.selectList(new LambdaQueryWrapper<BookingOrder>()
                .eq(BookingOrder::getHospitalCode, hospitalCode)
                .eq(BookingOrder::getDepartment, department)
                .ge(BookingOrder::getVisitTime, dayStart)
                .lt(BookingOrder::getVisitTime, dayEnd)
                .ne(BookingOrder::getStatus, "CANCELLED"));

        Map<LocalDateTime, Long> bookedByTime = booked.stream()
                .collect(Collectors.groupingBy(BookingOrder::getVisitTime, Collectors.counting()));

        return raw.stream()
                .map(s -> new HospitalAdapter.Slot(
                        s.visitTime(),
                        s.doctorName(),
                        // 不出现负数：号可能被其他渠道占掉，remaining 最低显示 0
                        Math.max(0, s.remaining() - bookedByTime.getOrDefault(s.visitTime(), 0L).intValue())))
                .toList();
    }

    public List<BookingOrder> list(long userId) {
        return bookingMapper.selectList(new LambdaQueryWrapper<BookingOrder>()
                .eq(BookingOrder::getUserId, userId)
                .orderByDesc(BookingOrder::getVisitTime));
    }

    public BookingOrder get(long userId, long id) {
        BookingOrder o = bookingMapper.selectById(id);
        // 不是自己的一律当不存在：报"无权访问"等于确认这个 id 存在
        if (o == null || !o.getUserId().equals(userId)) {
            throw new BizException(40400, "预约单不存在");
        }
        return o;
    }

    /**
     * 建单。
     *
     * <p>顺序很重要：<b>先问院方能不能约，再落库</b>。
     * 反过来先落库再问，院方失败时数据库里会留下一张永远挂着的单，
     * 而提醒引擎会继续为它排提醒 —— 用户收到"明天空腹抽血"，
     * 但那个号根本没约上。
     */
    @Transactional
    public BookingOrder create(long userId, BookingRequest req) {
        HospitalAdapter adapter = adapters.of(req.hospitalCode());

        HospitalAdapter.BookingResult result = adapter.book(req.department(), req.visitTime());
        if (!result.ok()) {
            // 原样带出院方给的原因：用户需要知道"是满了"还是"系统坏了"
            throw new BizException(40900, result.message());
        }

        BookingOrder order = new BookingOrder();
        order.setUserId(userId);
        order.setHospitalCode(req.hospitalCode());
        order.setDepartment(req.department());
        order.setVisitTime(req.visitTime());
        order.setStatus(BookingOrder.STATUS_CREATED);
        order.setExternalOrderNo(result.externalNo());
        order.setRemark(req.remark());
        bookingMapper.insert(order);

        log.info("建预约单 id={} hospital={} external={}",
                order.getId(), req.hospitalCode(), result.externalNo());
        return order;
    }

    @Transactional
    public BookingOrder changeStatus(long userId, long id, String target) {
        BookingOrder order = get(userId, id);
        String current = order.getStatus();

        Set<String> allowed = TRANSITIONS.getOrDefault(current, Set.of());
        if (!allowed.contains(target)) {
            throw new BizException(40901,
                    "当前状态（" + label(current) + "）不能变成" + label(target));
        }

        // 取消要回问院方：本地改状态但院方那边还占着号，是最坏的"看起来取消了" 
        if (BookingOrder.STATUS_CANCELLED.equals(target)) {
            HospitalAdapter adapter = adapters.of(order.getHospitalCode());
            HospitalAdapter.BookingResult r = adapter.cancel(order.getExternalOrderNo());
            if (!r.ok()) {
                throw new BizException(40902, "院方取消失败：" + r.message());
            }
        }

        order.setStatus(target);
        bookingMapper.updateById(order);
        log.info("预约单 {} 状态 {} -> {}", id, current, target);
        return order;
    }

    private String label(String status) {
        return switch (status == null ? "" : status) {
            case BookingOrder.STATUS_CREATED -> "待确认";
            case BookingOrder.STATUS_CONFIRMED -> "已确认";
            case BookingOrder.STATUS_COMPLETED -> "已完成";
            case BookingOrder.STATUS_CANCELLED -> "已取消";
            default -> status;
        };
    }
}
