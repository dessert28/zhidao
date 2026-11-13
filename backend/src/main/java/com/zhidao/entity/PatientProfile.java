package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 患者档案。
 *
 * <p><b>刻意没有的字段</b>：真名、身份证、手机号、住址。
 * 服务端只需要能区分"是同一个人"，不需要知道他是谁。
 * 这五个字段一旦落库，泄露面就从"设备丢失"扩大到"数据库被拖"。
 * 相关依据见 docs/08 §1 与 docs/09 硬约束之一。
 *
 * <p>{@code birthYear} 只到年份：临床上精确到日没有业务价值，
 * 但精确日期 + 地区是能用来重识别个人的准标识符。
 */
@Data
@TableName("patient_profile")
public class PatientProfile {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    /** 只存年份 */
    private Integer birthYear;

    /** MALE / FEMALE / OTHER */
    private String gender;

    /**
     * 过敏史 JSON 数组，如 {@code ["青霉素"]}。
     *
     * <p>为什么用 JSON 而不是关联表：这两份数据永远是"整份读取、整份覆盖"，
     * 没有按单项查询或分页的需求。拆表只会带来 join 成本和额外的事务边界。
     */
    private String allergyJson;

    /** 慢病 JSON 数组，如 {@code ["高血压","2型糖尿病"]} */
    private String chronicJson;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
