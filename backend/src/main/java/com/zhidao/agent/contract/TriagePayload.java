package com.zhidao.agent.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

/**
 * Triage Agent 载荷 —— 对照 contract.ts 的 Department / TriagePayload。
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
public class TriagePayload {

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static class Department {
        private String name;
        private double confidence;
        private String reason;
    }

    /** 1–3 个科室，每个带理由 */
    private List<Department> departments;
    private RedFlag redFlag;
    /** 已采集的症状槽位 */
    private Map<String, String> collectedSymptoms;
    /** 非 null 表示还需追问（status = need_clarify） */
    private String nextQuestion;
}
