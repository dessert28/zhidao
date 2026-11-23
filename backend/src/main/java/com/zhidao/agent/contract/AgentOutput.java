package com.zhidao.agent.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

/**
 * Agent 输出信封 —— 对照 frontend/src/types/contract.ts 的 AgentOutput。
 *
 * <p>status 四态是硬约束：ok / need_clarify / blocked / failed。
 * 失败必须走 failed/blocked，不允许异常穿透到调用方。
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
public class AgentOutput<T> {
    /** ok | need_clarify | blocked | failed */
    private String status;
    private T payload;
    /** 0–1 */
    private double confidence;
    private List<Map<String, Object>> evidence;
    private List<AgentEvent> events;
    /** 若降级过，说明原因 */
    private Map<String, Object> degraded;

    public static final String OK = "ok";
    public static final String NEED_CLARIFY = "need_clarify";
    public static final String BLOCKED = "blocked";
    public static final String FAILED = "failed";

    /** 降级说明快捷构造 */
    public static Map<String, Object> degrade(String stage, String reason, String fallback) {
        return Map.of("stage", stage, "reason", reason, "fallback", fallback);
    }
}
