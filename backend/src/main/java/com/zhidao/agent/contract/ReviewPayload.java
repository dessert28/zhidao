package com.zhidao.agent.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * Reviewer 载荷 —— 对照 contract.ts 的 ReviewScores / ReviewIssue / ReviewerPayload。
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
public class ReviewPayload {

    @Data @Builder @NoArgsConstructor @AllArgsConstructor
    public static class ReviewScores {
        private double safety;
        private double accuracy;
        private double completeness;
        private double groundedness;

        public static ReviewScores defaults() {
            return ReviewScores.builder().safety(0.6).accuracy(0.6)
                    .completeness(0.6).groundedness(0.6).build();
        }
    }

    @Data @Builder @NoArgsConstructor @AllArgsConstructor
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static class ReviewIssue {
        /** ungrounded | unsafe | incomplete | inaccurate */
        private String type;
        private String detail;
        /** removed | rewritten | flagged | blocked */
        private String action;
    }

    private ReviewScores scores;
    private double overall;
    private List<ReviewIssue> issues;
    private String caveat;
}
