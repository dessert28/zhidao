package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 问诊对话的一条消息。
 *
 * <p><b>关于 {@code content}</b>：存的是**已脱敏**的文本。
 * 前端在组装请求体时就把手机号、身份证、住址换掉了（lib/privacy/context.ts），
 * 这里拿到的从来不是原文 —— 和 {@link MedicalRecord#getOcrText()} 同一条纪律。
 * 所以这张表即使被拖走，也拼不出一个可识别的患者。
 *
 * <p><b>关于 {@code userId} 与 {@code sessionId} 同时存在</b>：
 * 只按 sessionId 查是不够的，它由前端生成、前端可改，
 * 单靠它过滤等于把"看谁的对话"交给调用方决定。
 * userId 必须来自 JWT（见 {@code CurrentUser}），是查询的强制条件。
 *
 * <p>没有 {@code updatedAt}：消息写出后不再修改。
 * 允许编辑历史消息等于允许事后改写"我当时说了什么"，
 * 这在医疗场景里不能接受。
 */
@Data
@TableName("chat_message")
public class ChatMessage {

    /** 消息角色：患者说的 */
    public static final String ROLE_USER = "user";

    /** 消息角色：助手说的 */
    public static final String ROLE_ASSISTANT = "assistant";

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 归属患者；来自 JWT，绝不从请求参数读取 */
    private Long userId;

    /** 会话标识，由前端生成，用于在同一用户的多次对话之间区分 */
    private String sessionId;

    /** 一问一答的配对键：同一次提问的 user/assistant 两条消息共用 */
    private String turnId;

    /** {@link #ROLE_USER} / {@link #ROLE_ASSISTANT} */
    private String role;

    /** 脱敏后的文本；原文不落库 */
    private String content;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    /** 逻辑删除：用户清空会话时置 1，行本身保留以备追溯 */
    @TableLogic
    private Integer deleted;
}
