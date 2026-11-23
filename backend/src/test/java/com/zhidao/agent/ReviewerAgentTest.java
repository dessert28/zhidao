package com.zhidao.agent;

import com.zhidao.agent.contract.ReviewPayload.ReviewIssue;
import com.zhidao.agent.contract.ReviewPayload.ReviewScores;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class ReviewerAgentTest {

    private ReviewerAgent reviewer;

    @BeforeEach
    void setUp() {
        reviewer = new ReviewerAgent();
    }

    @Test
    @DisplayName("安全规则：诊断+处方被改写，逐字对齐 TS 版")
    void safetyRewrite() {
        ReviewerAgent.SafetyResult r = reviewer.applySafetyRules("你这是胃炎，建议吃布洛芬");
        assertFalse(r.blocked());
        assertEquals(2, r.issues().size());
        assertEquals("这些表现可能和某些疾病相关，但需要医生面诊确认。，具体用什么药需要医生根据你的情况开处方。",
                r.answer());
    }

    @Test
    @DisplayName("安全规则：确诊+二甲双胍被改写")
    void diagnosisDrug() {
        ReviewerAgent.SafetyResult r = reviewer.applySafetyRules("确诊为糖尿病，建议服用二甲双胍");
        assertEquals("这些表现可能和某些疾病相关，但需要医生面诊确认。，具体用什么药需要医生根据你的情况开处方。",
                r.answer());
    }

    @Test
    @DisplayName("剂量规则整段拦截（blocked）")
    void dosageBlocked() {
        ReviewerAgent.SafetyResult r = reviewer.applySafetyRules("每次服用 500mg，每日三次");
        assertTrue(r.blocked());
        assertEquals("每次服用 500mg，每日三次", r.answer());
        assertEquals("blocked", r.issues().get(0).getAction());
    }

    @Test
    @DisplayName("弱化就医必要性被改写")
    void replaceDoctor() {
        ReviewerAgent.SafetyResult r = reviewer.applySafetyRules("不用去看医生，自己买点药吃");
        assertEquals("是否需要就医建议还是让医生判断。，自己买点药吃", r.answer());
    }

    @Test
    @DisplayName("安全建议原样通过")
    void safeAnswerUnchanged() {
        String safe = "建议到内分泌科复查，带上化验单";
        assertEquals(safe, reviewer.applySafetyRules(safe).answer());
        assertTrue(reviewer.applySafetyRules(safe).issues().isEmpty());
    }

    @Test
    @DisplayName("四维规则分与整体分对齐 TS 版")
    void scores() {
        ReviewScores good = reviewer.ruleBasedScores("建议到内分泌科复查带上化验单", 2, 0);
        assertEquals(1.0, good.getSafety(), 0.001);
        assertEquals(0.75, good.getAccuracy(), 0.001);
        assertEquals(0.75, good.getCompleteness(), 0.001);
        assertEquals(0.85, good.getGroundedness(), 0.001);

        ReviewScores bad = reviewer.ruleBasedScores("你这是胃炎", 0, 1);
        assertEquals(0.0, bad.getSafety(), 0.001);
        assertEquals(0.6, bad.getAccuracy(), 0.001);
        assertEquals(0.55, bad.getCompleteness(), 0.001);
        assertEquals(0.6, bad.getGroundedness(), 0.001);

        assertEquals(0.87, reviewer.overallScore(good), 0.001);
        assertTrue(reviewer.belowThreshold(bad, ReviewScores.defaults()));
    }

    @Test
    @DisplayName("剥掉就医指引句，保留病情描述句")
    void stripGuidance() {
        String out = reviewer.stripEmergencyGuidance(
                "你这是卒中需要马上手术。若出现一侧肢体无力应立即拨打 120。");
        assertEquals("你这是卒中需要马上手术。", out);
    }

    @Test
    @DisplayName("过敏交叉检查：提及过敏物 → 警示")
    void allergyCheck() {
        ReviewerAgent.Facts facts = new ReviewerAgent.Facts(
                List.of("青霉素"), List.of(), List.of("阿司匹林", "布洛芬"));
        ReviewerAgent.CrossCheckResult r = reviewer.allergyCrosscheck("可以用青霉素类药物治疗", facts);
        assertEquals(1, r.issues().size());
        assertEquals("flagged", r.issues().get(0).getAction());
        assertTrue(r.warnings().get(0).contains("青霉素"));
    }

    @Test
    @DisplayName("用药冲突：答案同时提及多种在用药物 → 警示")
    void drugConflict() {
        ReviewerAgent.Facts facts = new ReviewerAgent.Facts(
                List.of("青霉素"), List.of(), List.of("阿司匹林", "布洛芬"));
        ReviewerAgent.CrossCheckResult r = reviewer.drugConflictCheck("同时在用阿司匹林和布洛芬", facts);
        assertEquals(1, r.issues().size());
        assertTrue(r.warnings().get(0).contains("阿司匹林、布洛芬"));
    }

    @Test
    @DisplayName("只有一种用药时不报冲突")
    void singleDrugNoConflict() {
        ReviewerAgent.Facts facts = new ReviewerAgent.Facts(List.of(), List.of(), List.of("阿司匹林"));
        assertTrue(reviewer.drugConflictCheck("在用阿司匹林", facts).issues().isEmpty());
    }
}
