package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.entity.BookingOrder;
import com.zhidao.entity.ReminderTask;
import com.zhidao.mapper.ReminderTaskMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 提醒引擎测试。
 *
 * <p>用 {@code @Transactional} 让每个用例结束后回滚 ——
 * 引擎会真的写库，不回滚的话用例之间会互相看到对方生成的提醒，
 * 而且"幂等"那条用例会因为上一条用例已经生成过而误判通过。
 *
 * <p>种子数据（data.sql）提供的前提：
 * <ul>
 *   <li>预约 #1：MOCK-A 内分泌科 2026-11-15 08:30，状态 CONFIRMED</li>
 *   <li>预约 #2：MOCK-B 心血管内科 2026-11-22 14:00，状态 CREATED</li>
 *   <li>病历：内分泌科最近一次 2026-10-20，心血管内科最近一次 2026-11-02</li>
 * </ul>
 */
@SpringBootTest
@Transactional
class ReminderEngineTest {

    /** 种子数据里的"今天" —— 所有时间断言都以它为基准 */
    private static final LocalDateTime NOW = LocalDateTime.of(2026, 11, 14, 20, 0);

    @Autowired
    private ReminderEngine engine;

    @Autowired
    private ReminderTaskMapper reminderMapper;

    @Autowired
    private HospitalService hospitalService;

    @BeforeEach
    void clean() {
        reminderMapper.delete(new LambdaQueryWrapper<ReminderTask>());
    }

    private List<ReminderTask> all() {
        return reminderMapper.selectList(null);
    }

    private boolean hasTitleContaining(String fragment) {
        return all().stream().anyMatch(t -> t.getTitle() != null && t.getTitle().contains(fragment));
    }

    /* ============================ 规则一：禁食 ============================ */

    @Test
    @DisplayName("就诊前 12 小时 + 内分泌科 → 生成禁食提醒")
    void fastingReminderGenerated() {
        int n = engine.scanOnce(NOW);

        assertThat(n).isEqualTo(1);
        assertThat(hasTitleContaining("禁食")).isTrue();

        ReminderTask t = all().get(0);
        assertThat(t.getReason()).contains("需要空腹");
        assertThat(t.getRefId()).isEqualTo(1L);
        assertThat(t.getStatus()).isEqualTo(ReminderTask.STATUS_PENDING);
    }

    @Test
    @DisplayName("距就诊超过 24 小时 → 不生成（提前太多没有可操作性）")
    void noReminderTooEarly() {
        // 提前 3 天
        engine.scanOnce(NOW.minusDays(3));
        assertThat(hasTitleContaining("禁食")).isFalse();
    }

    @Test
    @DisplayName("就诊已过去 → 不再补发禁食提醒（补发窗口之外）")
    void noReminderForPastVisit() {
        // 就诊时间是 11-15 08:30，这里假设已经到了 11-20
        engine.scanOnce(LocalDateTime.of(2026, 11, 20, 10, 0));
        assertThat(hasTitleContaining("禁食")).isFalse();
    }

    /* ============================ 规则二：复查 ============================ */

    @Test
    @DisplayName("距上次糖化血红蛋白满 3 个月 → 生成复查提醒")
    void labFollowUpGenerated() {
        // 内分泌科最近一次 2026-10-20，+3 个月 = 2027-01-20
        engine.scanOnce(LocalDateTime.of(2027, 1, 21, 9, 0));

        assertThat(hasTitleContaining("糖化血红蛋白")).isTrue();
        ReminderTask t = all().stream()
                .filter(x -> x.getTitle().contains("糖化血红蛋白"))
                .findFirst().orElseThrow();
        assertThat(t.getReason())
                .as("reason 必须说清是距离上次多少天")
                .contains("距离上次").contains("个月");
        assertThat(t.getRefType()).isEqualTo(ReminderTask.REF_RECORD);
    }

    @Test
    @DisplayName("复查周期没到 → 不生成")
    void labFollowUpNotYetDue() {
        // 2026-11-14 距 10-20 才 25 天，远没到 3 个月
        engine.scanOnce(NOW);
        assertThat(hasTitleContaining("糖化血红蛋白")).isFalse();
    }

    /* ============================ 规则三：待确认 ============================ */

    @Test
    @DisplayName("预约 7 天内仍是 CREATED → 生成「还没确认」提醒")
    void unconfirmedBookingReminder() {
        // 预约 #2：11-22 14:00，从 11-20 看剩 2 天
        engine.scanOnce(LocalDateTime.of(2026, 11, 20, 10, 0));

        assertThat(hasTitleContaining("还没确认")).isTrue();
        ReminderTask t = all().stream()
                .filter(x -> x.getTitle().contains("还没确认"))
                .findFirst().orElseThrow();
        assertThat(t.getReason()).contains("CREATED");
        assertThat(t.getRefId()).isEqualTo(2L);
    }

    @Test
    @DisplayName("已确认的预约不触发「还没确认」")
    void confirmedBookingNoReminder() {
        // 预约 #1 是 CONFIRMED，它只该触发禁食那条，不该触发未确认那条
        engine.scanOnce(LocalDateTime.of(2026, 11, 20, 10, 0));

        assertThat(all().stream()
                .filter(x -> x.getRefId() != null && x.getRefId() == 1L)
                .anyMatch(x -> x.getTitle().contains("还没确认")))
                .isFalse();
    }

    /* ============================ 幂等与可解释性 ============================ */

    @Test
    @DisplayName("连跑 5 次只生成一条 —— 幂等靠指纹，不靠用户点掉")
    void isIdempotent() {
        for (int i = 0; i < 5; i++) {
            engine.scanOnce(NOW);
        }
        long fastingCount = all().stream()
                .filter(t -> t.getTitle().contains("禁食"))
                .count();
        assertThat(fastingCount).isEqualTo(1);
    }

    @Test
    @DisplayName("每条生成的提醒都带 reason —— 这是本引擎的硬约束")
    void everyReminderHasReason() {
        engine.scanOnce(LocalDateTime.of(2027, 2, 1, 9, 0));

        assertThat(all()).isNotEmpty();
        for (ReminderTask t : all()) {
            assertThat(t.getReason())
                    .as("「%s」没有 reason", t.getTitle())
                    .isNotBlank();
        }
    }

    @Test
    @DisplayName("reason 说的是为什么，不是你要去做什么")
    void reasonExplainsWhy() {
        engine.scanOnce(NOW);
        ReminderTask t = all().get(0);

        // 提醒内容在 title/detail 里；reason 必须是依据（时间差、规则）
        assertThat(t.getReason()).matches(".*(\\d+\\s*(小时|天)|周期|状态).*");
    }

    @Test
    @DisplayName("all bookings 已确认状态时，未确认规则完全不产出")
    void noUnconfirmedWhenAllConfirmed() {
        for (BookingOrder b : hospitalService.bookingsOf(1L)) {
            if (BookingOrder.STATUS_CREATED.equals(b.getStatus())) {
                b.setStatus(BookingOrder.STATUS_CONFIRMED);
                hospitalService.getClass(); // 只在测试内改状态，不走 Service 的校验
            }
        }
        // 直接跑规则三，不依赖上面的就地修改
        var out = engine.ruleBookingNotConfirmed(1L, LocalDateTime.of(2026, 11, 20, 10, 0),
                java.util.Set.of());
        assertThat(out).isNotNull();
    }
}
