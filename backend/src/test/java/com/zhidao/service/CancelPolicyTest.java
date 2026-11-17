package com.zhidao.service;

import com.zhidao.entity.BookingOrder;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 退号规则测试。
 *
 * <p>规则的边界（正好 24 小时那一刻）最容易写错，
 * 而写错的后果是"以为还能退，点了却说不能"。
 */
class CancelPolicyTest {

    private static final LocalDateTime NOW = LocalDateTime.of(2026, 11, 16, 10, 0);

    private BookingOrder order(String status, LocalDateTime visitTime) {
        BookingOrder o = new BookingOrder();
        o.setId(1L);
        o.setStatus(status);
        o.setVisitTime(visitTime);
        return o;
    }

    @Test
    @DisplayName("就诊在 24 小时之外 → 可以自助退号")
    void farEnoughAhead() {
        BookingOrder o = order(BookingOrder.STATUS_CREATED, NOW.plusDays(2));
        assertNull(CancelPolicy.blockedReason(o, NOW));
    }

    @Test
    @DisplayName("距就诊不足 24 小时 → 引导到窗口")
    void tooClose() {
        BookingOrder o = order(BookingOrder.STATUS_CONFIRMED, NOW.plusHours(3));
        String reason = CancelPolicy.blockedReason(o, NOW);
        assertNotNull(reason);
        assertTrue(reason.contains("窗口"), "应引导到窗口而不是只说不行");
    }

    @Test
    @DisplayName("正好 24 小时 → 仍可退（边界包含在内）")
    void exactlyAtDeadline() {
        /*
         * 边界取"可退"而不是"不可退"：
         * 截止时间是给患者看的承诺，卡在最后一刻的用户应该被善待。
         */
        BookingOrder o = order(BookingOrder.STATUS_CREATED, NOW.plusHours(24));
        assertNull(CancelPolicy.blockedReason(o, NOW));
    }

    @Test
    @DisplayName("已取消的单 → 说明已经取消过，不是报错")
    void alreadyCancelled() {
        BookingOrder o = order(BookingOrder.STATUS_CANCELLED, NOW.plusDays(5));
        String reason = CancelPolicy.blockedReason(o, NOW);
        assertNotNull(reason);
        assertTrue(reason.contains("取消过"));
    }

    @Test
    @DisplayName("已完成 → 不能再取消")
    void completed() {
        BookingOrder o = order(BookingOrder.STATUS_COMPLETED, NOW.minusDays(1));
        assertNotNull(CancelPolicy.blockedReason(o, NOW));
    }

    @Test
    @DisplayName("就诊时间缺失 → 给可执行的指引，不抛异常")
    void missingVisitTime() {
        BookingOrder o = order(BookingOrder.STATUS_CREATED, null);
        assertNotNull(CancelPolicy.blockedReason(o, NOW));
    }

    @Test
    @DisplayName("deadlineOf 给出截止时间点")
    void deadline() {
        BookingOrder o = order(BookingOrder.STATUS_CREATED, NOW.plusDays(3));
        assertTrue(CancelPolicy.deadlineOf(o).isBefore(o.getVisitTime()));
    }
}
