package com.zhidao.service;

import com.zhidao.entity.BookingOrder;

import java.time.Duration;
import java.time.LocalDateTime;

/**
 * 退号规则 —— 「什么时候还能退」。
 *
 * <p>单独一个类而不是写在 {@link BookingService} 里，理由和状态机一样：
 * 这是<b>政策</b>而不是流程。政策会变（不同医院截止时间不同、
 * 有时限外仍可退），流程不该跟着改。
 *
 * <p>真实场景里的截止规则各院不同，这里给一个能覆盖多数三甲的默认值：
 * <b>就诊前 24 小时可以自助退号</b>。少于 24 小时需要到窗口办理，
 * 因为号已经进入排班，退出来也来不及给别人。
 *
 * <p>为什么这个规则必须存在而不是"随时可退"：
 * 号源是稀缺资源。下午的号上午随时能退，那个号就废了 ——
 * 对真正需要看病的其他人不公平。限制退号是为了让号能流回池子。
 */
public final class CancelPolicy {

    private CancelPolicy() {
    }

    /**
     * 自助退号的提前量。
     *
     * <p>取 24 小时：这是三甲医院预约挂号里最常见的口径。
     * 演示环境也用它，因为它足够宽（不会让演示时"退不了"）
     * 又足够有说服力（能讲清"为什么不是随时可退"）。
     */
    public static final Duration SELF_SERVICE_WINDOW = Duration.ofHours(24);

    /**
     * 判断现在能否自助退号。
     *
     * @param order 预约单
     * @param now   当前时间
     * @return 可以退返回 null；不能退返回一句给患者看的原因
     */
    public static String blockedReason(BookingOrder order, LocalDateTime now) {
        if (order == null || order.getVisitTime() == null) {
            return "预约信息不完整，请到窗口办理。";
        }

        if (BookingOrder.STATUS_CANCELLED.equals(order.getStatus())) {
            /*
             * 已取消的单不该再"退一次"。
             * 但这句话需要说清楚：不是"操作失败"，而是"它已经取消了"——
             * 否则患者会以为取消没生效，反复点。
             */
            return "这个号已经取消过了。";
        }

        if (BookingOrder.STATUS_COMPLETED.equals(order.getStatus())) {
            return "这次就诊已完成，不能再取消。";
        }

        LocalDateTime deadline = order.getVisitTime().minus(SELF_SERVICE_WINDOW);
        if (now.isAfter(deadline)) {
            return "距就诊不足 24 小时，需要退号请到医院挂号窗口办理。"
                    + "自助退号在就诊前 24 小时停止，是为了让号能回到池子里给别人。";
        }

        return null;
    }

    /** 退号截止时间点。给界面显示"最晚什么时候还能退" */
    public static LocalDateTime deadlineOf(BookingOrder order) {
        return order.getVisitTime() == null ? null : order.getVisitTime().minus(SELF_SERVICE_WINDOW);
    }
}
