package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 患者与院区的绑定关系。
 *
 * <p>医院系统里没有我们这儿的用户 ID，必须有一个双方都认的标识。
 * 这里用「患者授权时由我方生成的一次性匹配码」，
 * 不用医保号/身份证 —— 那需要额外资质，且一旦泄露无法更换；
 * 匹配码可以随时作废重发。
 */
@Data
@TableName("patient_binding")
public class PatientBinding {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private String hospitalCode;

    /** 院方调阅时携带的匹配码 */
    private String matchCode;

    private Boolean enabled;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
