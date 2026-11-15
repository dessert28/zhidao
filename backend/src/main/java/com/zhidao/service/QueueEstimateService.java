package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.entity.BookingOrder;
import com.zhidao.mapper.BookingOrderMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * 排队估算 —— 「我还要等多久」。
 *
 * <h3>这是什么，不是什么</h3>
 *
 * <p><b>不是</b>院方实时叫号。真实叫号数据在院方系统里，
 * 我们拿不到（需要院方开放接口，docs/08 §5 已说明）。
 *
 * <p><b>是</b>基于我们自己能拿到的数据做估算：
 * 同一个院区 + 同一个科室 + 同一个就诊时段，已经约了多少人。
 * 排在前面的人越多，等待越久 —— 这个推断不完美但**有依据**，
 * 而且可以把依据展示给患者（"您前面还有 2 位"）。
 *
 * <h3>为什么不做成"第 5 位"</h3>
 *
 * <p>真实叫号是"挂号后取号、按号序叫"，而我们是预约时段制：
 * 同一时段的人谁先到谁先看，号序不等于顺序。
 * 说"您是第 5 位"会让患者以为可以先出去逛逛再回来 ——
 * 实际上晚到可能被排到后面。所以这里给的是**区间与建议**，
 * 不是确定的位次。
 *
 * <h3>估算方法</h3>
 *
 * <pre>
 *   前面的人数 = 同时段内、下单时间早于我、且未取消的预约数
 *   单人平均耗时 = 该科室的 estMinutes（来自院内地点配置，默认 15 分钟）
 *   预计等待 = 前面人数 × 单人耗时
 * </pre>
 *
 * <p>用**下单时间**而不是就诊时间排序：同一时段的人谁先约谁先看，
 * 这是预约制医院的通行规则。按就诊时间排会得到"同一时刻所有人并列"的
 * 无意义结果。
 *
 * <p><b>诚实边界</b>：这是估算，误差可能很大（医生看诊快慢、
 * 有人爽约、有人迟到都会影响）。所以返回值里带 {@code confidence}
 * 与 {@code disclaimer}，前端必须把它当参考而不是承诺展示。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class QueueEstimateService {

    private final BookingOrderMapper bookingMapper;

    /** 没有配置院内地点时的兜底单人耗时（分钟）。三甲门诊常见区间是 8-20 分钟 */
    private static final int DEFAULT_MINUTES_PER_PATIENT = 15;

    /**
     * 排队估算结果。
     *
     * @param aheadCount    前面大约还有几个人
     * @param waitMinutes   预计还要等多少分钟
     * @param reasonable    这次估算是否可靠（人数过少或不在当天时不可靠）
     * @param confidence    可信度：HIGH / MEDIUM / LOW
     * @param reason        为什么是这个结果，给患者看的
     * @param advice        现在该做什么
     * @param disclaimer    必须一起展示的免责说明
     */
    public record Estimate(
            int aheadCount,
            int waitMinutes,
            boolean reasonable,
            String confidence,
            String reason,
            String advice,
            String disclaimer
    ) {
    }

    /**
     * 估算某张预约单的排队情况。
     *
     * @param order          预约单
     * @param minutesPerPatient 该科室单人平均耗时；传 0 或负数用默认值
     * @param now            当前时间
     */
    public Estimate estimate(BookingOrder order, int minutesPerPatient, LocalDateTime now) {
        int perPatient = minutesPerPatient > 0 ? minutesPerPatient : DEFAULT_MINUTES_PER_PATIENT;

        /*
         * 统计同一个"时段"内的预约。
         *
         * 时段怎么定义：以该单的就诊时间为中心，前后各 30 分钟。
         * 不取整天：一天几十个号里大部分与自己无关，
         * 算进去会得出"前面还有 40 人"这种吓人且无意义的数字。
         * 30 分钟的窗口大致对应"同一个号源批次"。
         */
        LocalDateTime center = order.getVisitTime();
        LocalDateTime windowStart = center.minusMinutes(30);
        LocalDateTime windowEnd = center.plusMinutes(30);

        List<BookingOrder> sameBatch = bookingMapper.selectList(new LambdaQueryWrapper<BookingOrder>()
                .eq(BookingOrder::getHospitalCode, order.getHospitalCode())
                .eq(BookingOrder::getDepartment, order.getDepartment())
                .ge(BookingOrder::getVisitTime, windowStart)
                .le(BookingOrder::getVisitTime, windowEnd)
                // 取消掉的不占用队列
                .ne(BookingOrder::getStatus, "CANCELLED"));

        /*
         * 前面的人数 = 下单比我早的。
         *
         * 用 createdAt 排序而不是 id：id 是自增的，通常与下单顺序一致，
         * 但数据迁移/回滚后可能不一致。createdAt 才是真正的业务时间。
         * 两者相同的极端情况（同一毫秒）用 id 兜底保证确定性。
         */
        long ahead = sameBatch.stream()
                .filter(o -> !o.getId().equals(order.getId()))
                .filter(o -> {
                    if (o.getCreatedAt() == null || order.getCreatedAt() == null) {
                        return false;
                    }
                    int cmp = o.getCreatedAt().compareTo(order.getCreatedAt());
                    return cmp < 0 || (cmp == 0 && o.getId() < order.getId());
                })
                .count();

        int aheadCount = (int) ahead;
        int waitMinutes = aheadCount * perPatient;

        /*
         * 可信度判定。
         *
         * 第一版用"是不是今天"当判据，实测发现这个判据太严：
         * 患者几乎总是**提前一天或更早**查看，于是永远得到
         * "无法估算" —— 功能等于不可用。
         *
         * 真正影响排队的不是"今天还是明天"，而是两个边界：
         *   · 距就诊还有很久（比如一周）→ 中途可能有人取消/加号，
         *     现在算出的人数没有参考价值
         *   · 已经过了就诊时间 → 大概率已在诊区，再算"等多久"没意义
         *
         * 所以改成：**距就诊 48 小时内**才算"有参考价值"。
         * 这个窗口覆盖了"明天上午"和"今天下午"两个最常见的查看时机，
         * 也正是排队人数基本定型的时段。
         */
        long minutesToVisit = Duration.between(now, order.getVisitTime()).toMinutes();
        boolean inFuture = order.getVisitTime().isAfter(now);
        boolean nearEnough = inFuture && minutesToVisit <= 48 * 60;

        String confidence;
        boolean reasonable;
        if (!inFuture) {
            // 已经过了就诊时间：不是"估算不准"，是"这场已经开始了"
            confidence = "LOW";
            reasonable = false;
        } else if (!nearEnough) {
            // 距就诊超过 48 小时：中途可能有人取消，现在的人数不作数
            confidence = "LOW";
            reasonable = false;
        } else {
            confidence = "MEDIUM";
            reasonable = true;
        }

        String reason = buildReason(aheadCount, perPatient, nearEnough, inFuture);
        String advice = buildAdvice(aheadCount, waitMinutes, minutesToVisit, nearEnough, inFuture);

        return new Estimate(
                aheadCount,
                waitMinutes,
                reasonable,
                confidence,
                reason,
                advice,
                "以上是按时段预约人数估算的参考值，不是院方实时叫号。"
                        + "实际等待受医生看诊快慢、有人爽约或迟到影响，请以现场叫号为准。"
        );
    }

    private String buildReason(int ahead, int perPatient, boolean nearEnough, boolean inFuture) {
        if (!inFuture) {
            return "预约时间已过，如果还没看上，请到诊区服务台确认。";
        }
        if (!nearEnough) {
            return "距就诊还有一段时间，中途可能有人改约，现在的人数还不够准；临近再看一次更可靠。";
        }
        if (ahead == 0) {
            return "同一时段内没有比你更早预约的人，到了通常可以直接看。";
        }
        return String.format(
                "同一时段内，比你更早预约的还有 %d 位；按该科室平均每人 %d 分钟估算。",
                ahead, perPatient);
    }

    private String buildAdvice(
            int ahead, int waitMinutes, long minutesToVisit, boolean nearEnough, boolean inFuture) {

        if (!inFuture) {
            return "请以现场叫号为准；有疑问到诊区服务台咨询。";
        }
        if (!nearEnough) {
            return "临近就诊日再来看一次，那时的排队人数更接近实际情况。";
        }

        /*
         * 建议的核心是"现在来合不合适"。
         *
         * 提前量取 20 分钟：报到、找诊区、二次签到都需要时间，
         * 掐着点到的患者经常因为找不到诊区而过号。
         */
        long suggestLeaveIn = minutesToVisit - 20;

        if (suggestLeaveIn > 60) {
            return String.format(
                    "现在出发还早（约 %.0f 分钟后才是建议出发时间），可以先处理别的事，"
                            + "留意别迟到。", (double) suggestLeaveIn);
        }
        if (suggestLeaveIn > 0) {
            return String.format("建议约 %.0f 分钟后出发，预留 20 分钟用于报到和找诊区。",
                    (double) suggestLeaveIn);
        }
        if (ahead == 0) {
            return "可以现在到诊区报到，通常不用等太久。";
        }
        return String.format(
                "建议现在就出发。前面约 %d 位，预计等 %d 分钟左右。", ahead, waitMinutes);
    }

    /**
     * 给一组预约估算，用于"同一时段的人都排在哪"。
     *
     * <p>只在需要"排队全景"时用（比如确认预约后展示"你是这批的第几个"）。
     * 单个估算用 {@link #estimate} 就够。
     */
    public List<Estimate> estimateAll(List<BookingOrder> orders, int minutesPerPatient, LocalDateTime now) {
        List<Estimate> out = new ArrayList<>(orders.size());
        for (BookingOrder o : orders) {
            out.add(estimate(o, minutesPerPatient, now));
        }
        return out;
    }
}
