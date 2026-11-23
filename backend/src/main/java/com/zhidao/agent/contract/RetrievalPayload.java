package com.zhidao.agent.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * Retrieval Agent 载荷 —— 对照 contract.ts 的 Source / RetrievalPayload。
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
public class RetrievalPayload {

    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Source {
        private String docId;
        private String title;
        private String snippet;
        private double score;
    }

    private String answer;
    private List<Source> sources;
    private int roundsUsed;
    private List<String> refinedQueries;
    private boolean lowEvidence;
}
