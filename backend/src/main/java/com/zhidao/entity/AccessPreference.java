package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 患者的调阅授权偏好。
 *
 * <p>默认允许就诊期间自动授权 —— 这是诊疗必需，也是行业惯例。
 * 患者可以关闭；关闭后院方调阅会收到 403，必须患者当次确认。
 */
@Data
@TableName("access_preference")
public class AccessPreference {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    /** 是否允许就诊期间自动授权院方调阅 */
    private Boolean autoGrant;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
