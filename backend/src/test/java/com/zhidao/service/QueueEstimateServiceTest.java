package com.zhidao.service;

import com.zhidao.entity.BookingOrder;
import com.zhidao.mapper.BookingOrderMapper;
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
 * 排队估算测试。
 *
 * <p>这块最容易出两类问题：
 * <ul>
 *   <li><b>算出没有依据的数字</b> —— 比如明天就诊却给"前面还有 3 人"，
 *       患者照着这个数字决定几点出发，结果完全是错的</li>
 *   <li><b>该给建议时不说话</b> —— 估算了却不告诉患者"现在要不要出发"，
 *       等于只给焦虑不给行动</li>
 * </ul>
 * 所以测试同时覆盖"能算对"和"算不对时要坦白"。
 */
@SpringBootTest
@Transactional
@DisplayName("排队估算：有依据才算，算不准要坦白")
class QueueEstimateServiceTest {

    @Autowired
    private QueueEstimateService queueService;

    @Autowired
    private BookingOrderMapper bookingMapper;

    private LocalDateTime today1030() {
        return LocalDateTime.now().withHour(10).withMinute(30).withSecond(0).withNano(0);
    }

    private BookingOrder mkOrder(long id, LocalDateTime visit, LocalDateTime created, String status) {
        BookingOrder o = new BookingOrder();
        o.setId(id);
        /*
         * user_id 是必填列。这些测试数据都挂到演示账号（1）上 ——
         * 排队估算只看院区/科室/时段/下单时间，不区分用户；
         * 但插库时这一列不能为空，所以显式给一个。
         */
        o.setUserId(1L);
        o.setHospitalCode("QUEUE-TEST");
        o.setDepartment("测试科");
        o.setVisitTime(visit);
        o.setCreatedAt(created);
        o.setStatus(status);
        return o;
    }

    @BeforeEach
    void clean() {
        bookingMapper.delete(new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<BookingOrder>()
                .eq(BookingOrder::getHospitalCode, "QUEUE-TEST"));
    }

    /* ============================ 能算对 ============================ */

    @Test
    @DisplayName("前面有人时按人数与单人耗时算出等待")
    void countsAheadAndWait() {
        LocalDateTime visit = LocalDateTime.now().plusHours(3);
        LocalDateTime base = LocalDateTime.now();

        BookingOrder me = mkOrder(100, visit, base, "CREATED");
        bookingMapper.insert(me);
        // 两个比我早约的
        bookingMapper.insert(mkOrder(101, visit, base.minusMinutes(10), "CREATED"));
        bookingMapper.insert(mkOrder(102, visit, base.minusMinutes(5), "CREATED"));

        var est = queueService.estimate(me, 20, LocalDateTime.now());

        assertThat(est.aheadCount()).isEqualTo(2);
        assertThat(est.waitMinutes()).isEqualTo(40); // 2 × 20
        assertThat(est.confidence()).isEqualTo("MEDIUM");
        assertThat(est.reasonable()).isTrue();
    }

    @Test
    @DisplayName("取消的人不占队列")
    void cancelledDoesNotCount() {
        LocalDateTime visit = LocalDateTime.now().plusHours(3);
        LocalDateTime base = LocalDateTime.now();

        BookingOrder me = mkOrder(200, visit, base, "CREATED");
        bookingMapper.insert(me);
        bookingMapper.insert(mkOrder(201, visit, base.minusMinutes(10), "CANCELLED"));

        var est = queueService.estimate(me, 20, LocalDateTime.now());
        assertThat(est.aheadCount())
                .as("取消的预约不应算在前面还有几个人里")
                .isZero();
    }

    @Test
    @DisplayName("比我晚约的人不算在我前面")
    void laterBookingNotAhead() {
        LocalDateTime visit = LocalDateTime.now().plusHours(3);
        LocalDateTime base = LocalDateTime.now();

        BookingOrder me = mkOrder(300, visit, base, "CREATED");
        bookingMapper.insert(me);
        bookingMapper.insert(mkOrder(301, visit, base.plusMinutes(10), "CREATED"));

        var est = queueService.estimate(me, 20, LocalDateTime.now());
        assertThat(est.aheadCount()).isZero();
    }

    @Test
    @DisplayName("不同时段的预约不算在同一批")
    void differentSlotNotCounted() {
        LocalDateTime visit = LocalDateTime.now().plusHours(3);
        LocalDateTime base = LocalDateTime.now();

        BookingOrder me = mkOrder(400, visit, base, "CREATED");
        bookingMapper.insert(me);
        // 早 3 小时是另一个批次
        bookingMapper.insert(mkOrder(401, visit.minusHours(3), base.minusMinutes(30), "CREATED"));

        var est = queueService.estimate(me, 20, LocalDateTime.now());
        assertThat(est.aheadCount())
                .as("30 分钟窗口外的预约不该算进来，否则会得出吓人的大数字")
                .isZero();
    }

    @Test
    @DisplayName("不同科室的预约不算在同一批")
    void differentDepartmentNotCounted() {
        LocalDateTime visit = LocalDateTime.now().plusHours(3);
        LocalDateTime base = LocalDateTime.now();

        BookingOrder me = mkOrder(500, visit, base, "CREATED");
        bookingMapper.insert(me);

        BookingOrder other = mkOrder(501, visit, base.minusMinutes(10), "CREATED");
        other.setDepartment("别的科");
        bookingMapper.insert(other);

        var est = queueService.estimate(me, 20, LocalDateTime.now());
        assertThat(est.aheadCount()).isZero();
    }

    /* ============================ 算不准要坦白 ============================ */

    @Test
    @DisplayName("距就诊超过 48 小时 → LOW，说明中途可能有人改约")
    void farFutureIsLowConfidence() {
        // 3 天后：中途有人取消/加号的可能性很大，现在的人数不作数
        LocalDateTime visit = LocalDateTime.now().plusDays(3);
        BookingOrder me = mkOrder(600, visit, LocalDateTime.now(), "CREATED");
        bookingMapper.insert(me);

        var est = queueService.estimate(me, 20, LocalDateTime.now());

        assertThat(est.confidence()).isEqualTo("LOW");
        assertThat(est.reasonable()).isFalse();
        assertThat(est.reason()).contains("改约");
        assertThat(est.advice()).contains("临近");
    }

    @Test
    @DisplayName("明天就诊在 48 小时窗口内 → 给出真实人数")
    void tomorrowIsWithinWindow() {
        /*
         * 这一条是实测问题的回归：第一版用"是不是今天"当判据，
         * 患者提前一天查看永远得到"无法估算"，功能等于不可用。
         * 改成 48 小时窗口后，明天上午查看也能拿到有依据的数字。
         */
        LocalDateTime visit = LocalDateTime.now().plusDays(1).withHour(10).withMinute(0).withSecond(0).withNano(0);
        LocalDateTime base = LocalDateTime.now();

        BookingOrder me = mkOrder(650, visit, base, "CREATED");
        bookingMapper.insert(me);
        bookingMapper.insert(mkOrder(651, visit, base.minusMinutes(10), "CREATED"));

        var est = queueService.estimate(me, 20, LocalDateTime.now());

        assertThat(est.confidence())
                .as("明天上午在 48 小时窗口内，应当给出 MEDIUM 而不是 LOW")
                .isEqualTo("MEDIUM");
        assertThat(est.reasonable()).isTrue();
        assertThat(est.aheadCount()).isEqualTo(1);
    }

    @Test
    @DisplayName("预约时间已过 → LOW，提示去服务台确认")
    void pastVisitIsLowConfidence() {
        LocalDateTime visit = LocalDateTime.now().minusHours(2);
        BookingOrder me = mkOrder(700, visit, LocalDateTime.now().minusHours(5), "CREATED");
        bookingMapper.insert(me);

        var est = queueService.estimate(me, 20, LocalDateTime.now());

        assertThat(est.confidence()).isEqualTo("LOW");
        assertThat(est.reasonable()).isFalse();
        assertThat(est.reason()).contains("已过");
    }

    @Test
    @DisplayName("任何结果都带免责说明 —— 这是估算不是叫号")
    void alwaysHasDisclaimer() {
        BookingOrder me = mkOrder(800, LocalDateTime.now().plusHours(2), LocalDateTime.now(), "CREATED");
        bookingMapper.insert(me);

        var est = queueService.estimate(me, 20, LocalDateTime.now());
        assertThat(est.disclaimer())
                .as("必须说清这不是院方实时叫号")
                .contains("不是院方实时叫号");
    }

    /* ============================ 建议 ============================ */

    @Test
    @DisplayName("离就诊还很久时，建议先别急着出发")
    void adviceWhenTooEarly() {
        LocalDateTime visit = LocalDateTime.now().plusHours(4);
        BookingOrder me = mkOrder(900, visit, LocalDateTime.now(), "CREATED");
        bookingMapper.insert(me);

        var est = queueService.estimate(me, 20, LocalDateTime.now());
        assertThat(est.advice()).contains("还早");
    }

    @Test
    @DisplayName("快到就诊时间且有排队，建议现在就出发")
    void adviceWhenShouldLeaveNow() {
        LocalDateTime visit = LocalDateTime.now().plusMinutes(10);
        LocalDateTime base = LocalDateTime.now().minusMinutes(20);

        BookingOrder me = mkOrder(1000, visit, base, "CREATED");
        bookingMapper.insert(me);
        bookingMapper.insert(mkOrder(1001, visit, base.minusMinutes(5), "CREATED"));

        var est = queueService.estimate(me, 20, LocalDateTime.now());
        assertThat(est.advice()).contains("现在就出发");
    }

    @Test
    @DisplayName("前面没人时，建议直接去报到")
    void adviceWhenNobodyAhead() {
        LocalDateTime visit = LocalDateTime.now().plusMinutes(10);
        BookingOrder me = mkOrder(1100, visit, LocalDateTime.now().minusMinutes(20), "CREATED");
        bookingMapper.insert(me);

        var est = queueService.estimate(me, 20, LocalDateTime.now());
        assertThat(est.aheadCount()).isZero();
        assertThat(est.advice()).contains("报到");
    }

    /* ============================ 边界 ============================ */

    @Test
    @DisplayName("单人耗时传 0 或负数时用默认值，不产出 0 分钟的假乐观结果")
    void zeroMinutesFallsBackToDefault() {
        LocalDateTime visit = LocalDateTime.now().plusHours(2);
        LocalDateTime base = LocalDateTime.now().minusMinutes(30);

        BookingOrder me = mkOrder(1200, visit, base, "CREATED");
        bookingMapper.insert(me);
        bookingMapper.insert(mkOrder(1201, visit, base.minusMinutes(5), "CREATED"));

        var est = queueService.estimate(me, 0, LocalDateTime.now());
        assertThat(est.waitMinutes())
                .as("耗时没配时该用默认 15 分钟，而不是算出 0 分钟")
                .isEqualTo(15);
    }

    @Test
    @DisplayName("批量估算与单个估算结果一致")
    void batchMatchesSingle() {
        LocalDateTime visit = LocalDateTime.now().plusHours(2);
        LocalDateTime base = LocalDateTime.now().minusMinutes(30);

        BookingOrder a = mkOrder(1300, visit, base, "CREATED");
        BookingOrder b = mkOrder(1301, visit, base.minusMinutes(5), "CREATED");
        bookingMapper.insert(a);
        bookingMapper.insert(b);

        List<QueueEstimateService.Estimate> batch =
                queueService.estimateAll(List.of(a, b), 20, LocalDateTime.now());
        var single = queueService.estimate(b, 20, LocalDateTime.now());

        assertThat(batch).hasSize(2);
        assertThat(batch.get(1).aheadCount()).isEqualTo(single.aheadCount());
        assertThat(batch.get(1).waitMinutes()).isEqualTo(single.waitMinutes());
    }
}
