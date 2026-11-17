package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 预约单。
 *
 * <p>状态机（故意做得窄，状态越多越难保证一致性）：
 * <pre>
 *   CREATED ──确认──> CONFIRMED ──就诊──> COMPLETED
 *      │                  │
 *      └────取消──────────┴──> CANCELLED
 * </pre>
 * 合法迁移由 Service 层校验，不放在实体里 —— 实体只描述数据，
 * 状态迁移规则属于业务。
 */
@Data
@TableName("booking_order")
public class BookingOrder {

    public static final String STATUS_CREATED = "CREATED";
    public static final String STATUS_CONFIRMED = "CONFIRMED";
    public static final String STATUS_COMPLETED = "COMPLETED";
    public static final String STATUS_CANCELLED = "CANCELLED";

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private String hospitalCode;

    private String department;

    private LocalDateTime visitTime;

    private String status;

    /** 对方系统的单号。Mock 阶段为空，接真实院区后回填 */
    private String externalOrderNo;

    private String remark;

    /**
     * 患者自助签到的时间。
     *
     * <p><b>为什么单独一个字段而不是复用状态机</b>：
     * 签到不是一个"状态" —— 签到之后单子仍然是 CONFIRMED，
     * 它只是多了一个时间点。把签到塞进状态机（加个 CHECKED_IN 状态）
     * 会让"能不能取消"的判定跟着变复杂，而我们并不想让签到影响取消规则。
     *
     * <p><b>它是"本地签到"</b>：只表示患者在自己手机上点了"我已到院"，
     * 不代表院方系统里已经报到。界面上必须说清这一点，
     * 否则患者以为点完就不用去自助机了。
     */
    private LocalDateTime checkinAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
