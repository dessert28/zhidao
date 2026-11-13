package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 院区。
 *
 * <p>{@code hospitalCode} 是对外唯一标识（如 {@code MOCK-A}）。所有跨表、
 * 跨系统的引用一律用它，<b>不用主键也不建外键</b> —— 这是 docs/09 的第三条硬约束。
 *
 * <p>为什么不用外键：院区是外部系统，它的主键归属不在我们手里。
 * 对方换系统时主键可能重排，而我们的预约单里存着这个主键，
 * 就会静默指向另一家医院。用业务编码则天然稳定。
 */
@Data
@TableName("hospital")
public class Hospital {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 跨表引用只用这个字段 */
    private String hospitalCode;

    private String name;

    private String level;

    private String city;

    /** 适配器类型：MOCK / HL7 / FHIR。省赛只有 MOCK */
    private String adapterType;

    private Boolean enabled;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
