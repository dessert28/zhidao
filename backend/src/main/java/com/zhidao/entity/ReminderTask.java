package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 提醒任务 —— 提醒引擎的落点。
 *
 * <p>{@code reason} 是这张表最重要的字段，也是「监护层」这个说法的实证：
 * <b>每一条提醒都必须能说清楚"为什么提醒你"</b>。
 * 没有 reason 的提醒和手机日历的闹钟没有区别，
 * 而我们的差异点恰恰是"这条提醒是系统理解了你的就诊记录后自己想到的"。
 */
@Data
@TableName("reminder_task")
public class ReminderTask {

    public static final String STATUS_PENDING = "PENDING";
    public static final String STATUS_SENT = "SENT";
    public static final String STATUS_DONE = "DONE";
    public static final String STATUS_SKIPPED = "SKIPPED";

    /** 关联对象类型 */
    public static final String REF_BOOKING = "BOOKING";
    public static final String REF_RECORD = "RECORD";
    public static final String REF_PLAN = "PLAN";

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private String refType;

    /** 可能为空：表示不挂具体单据的独立提醒 */
    private Long refId;

    private String title;

    private String detail;

    /**
     * 为什么提醒（可解释性）。
     * 例：「距就诊还有 24 小时，且该科室开具了空腹抽血项目」
     */
    private String reason;

    /**
     * 幂等键：{@code 规则名|关联类型|关联id|判别串}。
     *
     * <p>为什么要有这一列，而不是从 title/reason 反推：
     * 反推意味着<b>改写一句文案就会让去重失效</b>——引擎每 5 分钟扫一次，
     * 文案一改就变成每 5 分钟多一条提醒。这个缺陷是测试抓出来的
     * （连跑 5 次生成了 5 条），当时的实现正是按 reason 前缀反解的。
     *
     * <p>手工录入或历史数据的这一列为 NULL —— NULL 不参与唯一约束，
     * 所以它们不受去重影响，也不会互相冲突。
     */
    private String dedupeKey;

    private LocalDateTime dueAt;

    /** PENDING -> SENT -> DONE / SKIPPED */
    private String status;

    private LocalDateTime sentAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
