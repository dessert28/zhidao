package com.zhidao.agent.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

/**
 * Supervisor 载荷 —— 对照 contract.ts 的 SupervisorPayload。
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
public class SupervisorPayload {
    /** triage | retrieve | schedule | multi | done */
    private String decision;
    private List<String> agents;
    /** 必填：给前端展示"AI 在想什么" */
    private String reason;
    private boolean requiresClarify;
    private List<String> missing;

    public static final List<String> VALID_DECISIONS =
            List.of("triage", "retrieve", "schedule", "multi", "done");
    public static final List<String> VALID_AGENTS =
            List.of("triage", "retrieval", "scheduler", "reviewer");
    /** 冲突消解的固定串行顺序 */
    public static final List<String> SERIAL_ORDER =
            List.of("triage", "retrieval", "scheduler");
}
