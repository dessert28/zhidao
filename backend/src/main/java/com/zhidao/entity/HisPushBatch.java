package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * HIS 推送批次记录 —— 幂等用。
 *
 * <p>院方推送失败会重试，同一个 batchId 可能到达多次。
 * 没有这张表时，重试会变成"同一份地点被写两遍"，患者看到重复的路线步骤。
 *
 * <p>为什么用院方给的 batchId 而不是内容哈希：院方内容里常带时间戳，
 * 每次重试哈希都不同，起不到去重作用。
 */
@Data
@TableName("his_push_batch")
public class HisPushBatch {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String hospitalCode;

    /** 院方给的批次号，在其院区内唯一 */
    private String batchId;

    /** PLACES / SLOTS。当前只实现 PLACES */
    private String pushType;

    private Integer itemCount;

    private Integer appliedCount;

    /** APPLIED / FAILED */
    private String result;

    private String message;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
