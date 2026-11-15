package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 院方接入凭据。
 *
 * <p>一家医院可能有多套凭据（生产 / 测试 / 轮换期），所以独立成表而不是
 * 挂在 {@code hospital} 上。也便于单独吊销而不影响院区本身。
 *
 * <p><b>{@code appSecret} 是可还原的明文（或应用层加密后的可解密值）</b>，
 * 不能用哈希 —— HMAC 验签必须拿到原文。这是对称签名的固有约束，
 * 任何"把密钥哈希存储"的方案都跑不通。保护手段只能是：
 * 库访问控制 + 应用层加密 + 永不经接口返回。
 */
@Data
@TableName("hospital_credential")
public class HospitalCredential {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String hospitalCode;

    /** 对外应用标识，可公开 */
    private String appKey;

    /** 签名密钥。绝不返回给任何接口 */
    private String appSecret;

    /** 用途标签：PROD / TEST / ROTATING */
    private String label;

    /** 院方对接人联系方式 */
    private String contact;

    private Boolean enabled;

    /** 最后成功调用时间，用于识别长期不用的凭据 */
    private LocalDateTime lastUsedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
