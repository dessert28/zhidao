package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 用户（认证主体）。
 *
 * <p>与 {@link PatientProfile} 分开的原因：认证和业务档案的生命周期不同。
 * 密码泄露要能单独禁用账号而不影响病历归属；档案重建也不该要求用户改密码。
 */
@Data
@TableName("sys_user")
public class SysUser {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String username;

    /** BCrypt 哈希。任何日志、接口响应都不得带出这个字段 */
    private String passwordHash;

    /** 恢复码哈希，用于跨设备登录（docs/12 §2.4 方案 B） */
    private String recoveryHash;

    private String role;

    private Boolean enabled;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    /** 逻辑删除标记，docs/09 硬约束之二 */
    @TableLogic
    private Integer deleted;
}
