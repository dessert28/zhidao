package com.zhidao.agent;

import lombok.Data;

import java.util.List;
import java.util.Map;

/**
 * 对话请求体 —— 对照 chat.ts 的 ChatBody。
 */
@Data
public class ChatRequest {
    private String turnId;
    private String sessionId;
    /** 脱敏后文本 */
    private String text;
    /** 用户纯问题（不含健康档案），可选 */
    private String question;
    private Map<String, Object> facts;
    private Map<String, String> knownSlots;
    private Integer round;
    private Integer lowScoreStreak;
}
