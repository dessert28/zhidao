package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;

/**
 * 调阅审计日志 —— 这套设计里最重要的一张表。
 *
 * <p>没有它，「就诊即授权」就退化成「院方随便看」。
 * 有了它，每一次访问都是可追溯、可向患者展示的具体事件。
 */
@Data
@TableName("access_audit")
public class AccessAudit {

    public static final String ACTION_VIEW_LIST = "VIEW_REPORT_LIST";
    public static final String ACTION_VIEW_DETAIL = "VIEW_REPORT_DETAIL";
    public static final String ACTION_ARCHIVED = "ARCHIVED";

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 被查阅的患者 */
    private Long userId;

    private String hospitalCode;

    private String appKey;

    private String action;

    /** 本次调阅关联的就诊日期 */
    private LocalDate visitDate;

    /** 调阅到的记录ID，逗号分隔 */
    private String recordIds;

    private Integer itemCount;

    /** 院方是否已回执归档 */
    private Boolean archived;

    private String clientIp;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
