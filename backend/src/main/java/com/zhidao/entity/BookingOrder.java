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

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
