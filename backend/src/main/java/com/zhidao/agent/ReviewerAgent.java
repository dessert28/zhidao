package com.zhidao.agent;

import com.zhidao.agent.contract.ReviewPayload;
import com.zhidao.agent.contract.ReviewPayload.ReviewIssue;
import com.zhidao.agent.contract.ReviewPayload.ReviewScores;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reviewer 规则层 —— 对照 frontend/server/agents/reviewer.ts 的纯规则部分。
 *
 * <p>安全硬拦截（诊断/处方/剂量/停药/替代医生）、过敏交叉检查、用药冲突、
 * 四维打分、整体评分、答案清洗全部是确定性规则，逐字对齐 TS 版。
 * 这是"AI 安全与可控性"最硬的一块证据 —— 答案在下发前必经这道关。
 *
 * <p>LLM-as-judge 通过 judgeFn 留接口（无 Key 时跳过，仅用规则分 + 免责声明），
 * 对应 TS 版 JudgeDeps 的可选注入。
 */
@Slf4j
@Component
public class ReviewerAgent {

    public static final String GENERIC_CAVEAT =
            "本回答仅用于信息整理与就诊准备参考，不构成诊断或用药建议。具体诊疗请遵医嘱。";
    private static final int LOW_SCORE_STREAK_LIMIT = 3;

    /** 会话硬事实（对照 SessionFacts） */
    public record Facts(List<String> allergies, List<String> chronicConditions,
                        List<String> currentMedications) {
        public static Facts empty() {
            return new Facts(List.of(), List.of(), List.of());
        }
    }

    private record SafetyRule(String id, Pattern pattern, String action,
                              String detail, String replacement) {}

    /** 安全硬拦截规则 —— 逐条对照 SAFETY_RULES */
    private static final List<SafetyRule> SAFETY_RULES = List.of(
            new SafetyRule("diagnosis",
                    Pattern.compile("(你(这是|得了|患了|属于)|确诊为|诊断为|可以确定(是|为)|一定是)[^。！？\\n]{0,20}(病|症|炎|癌|瘤|感染|障碍|综合征|感冒|流感|胃炎|肺炎)"),
                    "rewritten", "答案给出了诊断结论，已改写为\"可能相关，需医生确认\"",
                    "这些表现可能和某些疾病相关，但需要医生面诊确认。"),
            new SafetyRule("prescription",
                    Pattern.compile("(建议|可以|应该|试试|不妨)(吃|服用|用|吃点|喝|买点)[^。！？\\n]{0,12}(药|片|胶囊|颗粒|口服液|布洛芬|阿司匹林|对乙酰氨基酚|头孢|阿莫西林|奥美拉唑|二甲双胍|蒙脱石|板蓝根|感冒灵|连花清瘟)"),
                    "rewritten", "答案建议了具体用药，已删除（开药不在本项目范围内）",
                    "具体用什么药需要医生根据你的情况开处方。"),
            new SafetyRule("drug_advice",
                    Pattern.compile("(吃点|服用|口服|涂抹)[^。！？\\n]{0,6}(布洛芬|阿司匹林|对乙酰氨基酚|头孢|阿莫西林|奥美拉唑|二甲双胍|感冒药|消炎药|抗生素)"),
                    "rewritten", "答案推荐了具体药物，已删除",
                    "具体用药请由医生决定。"),
            new SafetyRule("dosage",
                    Pattern.compile("\\d+\\s*(mg|毫克|g|克|ml|毫升|片|粒)[^。！？\\n]{0,6}(每次|每日|一天|一日|口服)"),
                    "blocked", "答案给出了具体剂量，属于高风险内容，整段已拦截",
                    null),
            new SafetyRule("stop_medication",
                    Pattern.compile("(停药|停掉|停用|不用吃了|别再吃|换(成|用)别的?药|改用)"),
                    "rewritten", "答案涉及停药或换药建议，已改写为\"请咨询原开方医生\"",
                    "是否调整用药必须由原开方医生判断，请不要自行停药或换药。"),
            new SafetyRule("replace_doctor",
                    Pattern.compile("(不用(去看|找)医生|不需要(去)?医院|没必要(去)?检查|可以不去)"),
                    "rewritten", "答案弱化了就医必要性，已改写",
                    "是否需要就医建议还是让医生判断。")
    );

    private static final Pattern CONDITION = Pattern.compile("若|如果|一旦|假如|要是|如有|若有|倘若|万一");
    private static final Pattern ACTION = Pattern.compile(
            "拨打\\s*120|叫救护车|立即(就)?(医|就诊|到急诊)|尽快(就)?医|马上就医|急诊|不要自行开车");
    private static final Pattern NEGATED = Pattern.compile(
            "(不等于|不一定是|未必是|不是|排除|并非|不像是)[^，。；]{0,6}(心梗|心肌梗死|卒中|中风|大出血)");
    private static final Pattern CLOSURE = Pattern.compile("建议|需要|可以|请|考虑");

    /** 执行安全规则 —— 对照 applySafetyRules */
    public SafetyResult applySafetyRules(String answer) {
        String text = answer;
        List<ReviewIssue> issues = new ArrayList<>();
        boolean blocked = false;
        for (SafetyRule rule : SAFETY_RULES) {
            Matcher m = rule.pattern().matcher(text);
            if (!m.find()) continue;
            String matched = m.group();
            issues.add(ReviewIssue.builder().type("unsafe")
                    .detail(rule.detail() + "（命中片段：" + matched.substring(0, Math.min(30, matched.length())) + "）")
                    .action(rule.action()).build());
            if (rule.action().equals("blocked")) blocked = true;
            else if (rule.action().equals("rewritten") && rule.replacement() != null)
                text = rule.pattern().matcher(text).replaceFirst(Matcher.quoteReplacement(rule.replacement()));
            else if (rule.action().equals("removed"))
                text = rule.pattern().matcher(text).replaceAll("");
        }
        return new SafetyResult(text, issues, blocked);
    }

    public record SafetyResult(String answer, List<ReviewIssue> issues, boolean blocked) {}

    /** 对照 sanitizeAnswer */
    public SanitizeResult sanitizeAnswer(String answer) {
        SafetyResult r = applySafetyRules(answer);
        return new SanitizeResult(r.answer(), r.blocked());
    }
    public record SanitizeResult(String answer, boolean blocked) {}

    /** 剥掉带紧急处置指引的句子 —— 对照 stripEmergencyGuidance */
    public String stripEmergencyGuidance(String answer) {
        // split 保留分隔符：(?<=[。！？；\n])
        String[] sentences = answer.split("(?<=[。！？；\\n])");
        StringBuilder out = new StringBuilder();
        for (String s : sentences) {
            if (CONDITION.matcher(s).find() && ACTION.matcher(s).find()) continue;
            if (NEGATED.matcher(s).find()) continue;
            out.append(s);
        }
        return out.toString();
    }

    /** 过敏交叉检查 —— 对照 allergyCrosscheck */
    public CrossCheckResult allergyCrosscheck(String answer, Facts facts) {
        List<ReviewIssue> issues = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        if (facts.allergies() == null) return new CrossCheckResult(issues, warnings);
        for (String allergen : facts.allergies()) {
            if (allergen == null || allergen.isEmpty()) continue;
            if (!answer.contains(allergen)) continue;
            issues.add(ReviewIssue.builder().type("unsafe")
                    .detail("答案提及了你的过敏记录：" + allergen).action("flagged").build());
            warnings.add("⚠️ 你的记录里对「" + allergen
                    + "」过敏，本次回答提到了它。请务必主动告知医生你的过敏史。");
        }
        return new CrossCheckResult(issues, warnings);
    }

    /** 用药冲突提示 —— 对照 drugConflictCheck */
    public CrossCheckResult drugConflictCheck(String answer, Facts facts) {
        List<ReviewIssue> issues = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        List<String> meds = new ArrayList<>();
        if (facts.currentMedications() != null) {
            for (String m : facts.currentMedications()) if (m != null && !m.isEmpty()) meds.add(m);
        }
        if (meds.size() < 2) return new CrossCheckResult(issues, warnings);
        List<String> mentioned = new ArrayList<>();
        for (String m : meds) if (answer.contains(m)) mentioned.add(m);
        if (mentioned.size() >= 2) {
            String joined = String.join("、", mentioned);
            issues.add(ReviewIssue.builder().type("unsafe")
                    .detail("答案同时提到了多种在用药物：" + joined).action("flagged").build());
            warnings.add("⚠️ 你在不同医院开过「" + joined
                    + "」，请在就诊时把完整用药清单给医生看，确认能否同服。");
        }
        return new CrossCheckResult(issues, warnings);
    }

    public record CrossCheckResult(List<ReviewIssue> issues, List<String> warnings) {}

    /** 规则基础分 —— 对照 ruleBasedScores */
    public ReviewScores ruleBasedScores(String answer, int evidenceCount, int safetyIssues) {
        double safety = safetyIssues > 0 ? 0 : 1;
        double groundedness = evidenceCount >= 2 ? 0.85
                : evidenceCount == 1 ? 0.65
                : answer.length() > 120 ? 0.4 : 0.6;
        double completeness = CLOSURE.matcher(answer).find() ? 0.75 : 0.55;
        double accuracy = evidenceCount > 0 ? 0.75 : 0.6;
        return ReviewScores.builder().safety(safety).accuracy(accuracy)
                .completeness(completeness).groundedness(groundedness).build();
    }

    /** 整体评分（safety 权重最高）—— 对照 overallScore */
    public double overallScore(ReviewScores s) {
        double sum = s.getSafety() * 0.4 + s.getAccuracy() * 0.25
                + s.getGroundedness() * 0.2 + s.getCompleteness() * 0.15;
        return Math.round(sum * 100.0) / 100.0;
    }

    /** 是否低于阈值 —— 对照 belowThreshold */
    public boolean belowThreshold(ReviewScores s, ReviewScores t) {
        return s.getSafety() < t.getSafety() || s.getAccuracy() < t.getAccuracy()
                || s.getCompleteness() < t.getCompleteness()
                || s.getGroundedness() < t.getGroundedness();
    }

    public int lowScoreStreakLimit() {
        return LOW_SCORE_STREAK_LIMIT;
    }
}
