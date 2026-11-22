package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 系统公告。
 *
 * <p>单独一张表而不是复用院方知识库：知识库是「患者问什么答什么」的检索语料，
 * 公告是「院方主动要让所有患者看到」的广播。两者的生命周期完全不同 ——
 * 公告会过期、会置顶、会被撤下，知识库文档则是长期沉淀。
 * 混在一起，公告的置顶与过期逻辑会污染检索结果。
 *
 * <p>{@code status} 与 {@code publishedAt} 是两个独立的概念，不能合并：
 * 草稿（DRAFT）没有发布时间；已发布（PUBLISHED）的公告也可能被撤回后
 * 再次发布。用「publishedAt 是否为空」代替状态，撤稿就只能把时间抹掉，
 * 一旦重新发布，历史发布时间就丢了。
 */
@Data
@TableName("sys_notice")
public class SysNotice {

    public static final String STATUS_DRAFT = "DRAFT";
    public static final String STATUS_PUBLISHED = "PUBLISHED";

    @TableId(type = IdType.AUTO)
    private Long id;

    private String title;

    /** 正文。课设阶段按纯文本处理，前端自行换行渲染 */
    private String content;

    /** INFO 通知 / WARN 提醒 / URGENT 紧急 */
    private String level;

    /** 置顶。列表排序时优先于发布时间 */
    private Boolean pinned;

    /** PUBLISHED / DRAFT。草稿只对管理端可见 */
    private String status;

    /**
     * 发布时间。
     *
     * <p>为什么不直接用 createdAt：公告可以提前写好定时发布，
     * 创建时间与对外生效时间是两回事。患者端按这一列过滤
     * {@code publishedAt <= now}，才能支持"预定明天早上八点发"。
     */
    private LocalDateTime publishedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
