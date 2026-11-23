package com.zhidao.agent;

import com.zhidao.agent.contract.*;
import com.zhidao.agent.contract.ReviewPayload.ReviewScores;
import com.zhidao.agent.rules.RedFlagRule;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * 对话编排器 —— 对照 frontend/server/routes/chat.ts 的 runTurn 主干。
 *
 * <p>把红线、注入检测、话题切换、情绪短路、Supervisor 决策、三分支执行、
 * Reviewer 审查串成一条完整流程，产出事件列表（{@code List<AgentEvent>}）。
 * 与 TS 版的差别：multi 分支这里按 triage → retrieval 固定顺序串行执行
 * （TS 版是并发后按同序 flush，对前端而言输出顺序完全一致，但省去缓冲复杂度）。
 *
 * <p>这样做的好处：编排逻辑可脱离 HTTP 单测；Controller 只负责把事件编码成 SSE。
 *
 * <p><b>模型依赖是可选注入的：</b>有 Key 时 Supervisor 用模型做路由、
 * Triage 用模型抽槽位与排科室、检索分支用模型做安全复核；
 * 没 Key 时这三处传 null，全部退回规则。判断只在这里做一次（{@link #llm}.available()），
 * 与 TS 版把判断集中在一处的做法一致 —— 分散判断只要漏一处，
 * 评委本地就会因为 401 白屏。
 */
@Slf4j
@Component
public class ChatOrchestrator {

    private final RedFlagRule redFlagRule;
    private final ChatRules chatRules;
    private final SupervisorAgent supervisor;
    private final TriageAgent triage;
    private final RetrievalAgent retrieval;
    private final ReviewerAgent reviewer;
    private final SchedulerIntentParser scheduler;
    private final LlmAgentAdapter llm;

    public ChatOrchestrator(RedFlagRule redFlagRule, ChatRules chatRules,
                            SupervisorAgent supervisor, TriageAgent triage,
                            RetrievalAgent retrieval, ReviewerAgent reviewer,
                            SchedulerIntentParser scheduler, LlmAgentAdapter llm) {
        this.redFlagRule = redFlagRule;
        this.chatRules = chatRules;
        this.supervisor = supervisor;
        this.triage = triage;
        this.retrieval = retrieval;
        this.reviewer = reviewer;
        this.scheduler = scheduler;
        this.llm = llm;
    }

    /** 一轮对话的产出 */
    public record TurnResult(List<AgentEvent> events, Map<String, String> sessionSlots,
                             int sessionRound) {}

    /**
     * 执行一轮对话。
     *
     * @param req 请求体
     */
    public TurnResult run(ChatRequest req) {
        long started = System.currentTimeMillis();
        List<AgentEvent> events = new ArrayList<>();
        String text = req.getText() == null ? "" : req.getText();
        String turnId = req.getTurnId() != null ? req.getTurnId() : UUID.randomUUID().toString();

        // 会话状态：从请求恢复
        Map<String, String> sessionSlots = new HashMap<>();
        if (req.getKnownSlots() != null) sessionSlots.putAll(req.getKnownSlots());
        int sessionRound = req.getRound() != null ? req.getRound() : 0;
        String userQuestion = req.getQuestion() != null ? req.getQuestion() : text;

        /* 第 0 步：红线前置，不经 LLM */
        RedFlagRule.RedFlagResult red = redFlagRule.check(text);
        if (red.hit() != null) {
            events.add(AgentEvent.builder().type("emergency").redFlag(
                    Map.of("type", red.hit().getType(), "guidance", red.hit().getGuidance())).build());
            events.add(AgentEvent.builder().type("speech").text(red.hit().getGuidance())
                    .lang("zh-CN").seq(1).build());
            return done(events, turnId, started, sessionSlots, sessionRound, false);
        }

        /* 注入检测 */
        List<ChatRules.InjectionSignal> injection = chatRules.detectInjection(text);
        String refusal = "我只做就医导诊：帮你判断该挂哪个科、要准备什么、什么时候该去医院。\n"
                + "如果有不舒服的地方，直接说症状就行。";
        if (!injection.isEmpty()) {
            String remainder = chatRules.stripInjectionSentences(text);
            if (remainder.isEmpty()) {
                events.add(AgentEvent.plan("done", "输入为指令性内容，无实际就医需求", List.of()));
                events.add(AgentEvent.token(refusal));
                return done(events, turnId, started, sessionSlots, sessionRound, false);
            }
        }

        /* 话题切换 */
        boolean switched = sessionRound > 0 && chatRules.isTopicSwitch(userQuestion, sessionSlots);
        if (switched) {
            sessionSlots.clear();
            sessionRound = 0;
        }

        /* 情绪主诉短路 */
        if (chatRules.detectEmotion(userQuestion).hit()) {
            String reason = switched
                    ? "检测到新的主诉（情绪困扰），已清空上一话题的症状信息，转心理支持"
                    : "识别到情绪困扰主诉，优先给予共情并建议心理科";
            events.add(AgentEvent.plan("triage", reason, List.of("triage")));
            events.add(AgentEvent.token(ChatRules.EMOTION_COMFORT));
            events.add(AgentEvent.token("\n\n"));
            List<Map<String, Object>> emotionDepts = List.of(
                    deptMap("临床心理科", 0.82, "情绪困扰方面的主诉，适合由心理科评估"),
                    deptMap("精神卫生科", 0.6, "若情绪低落持续两周以上，可到精神卫生科进一步评估"),
                    deptMap("全科医学科", 0.4, "若同时有明显躯体不适，可先由全科排查身体原因"));
            events.add(AgentEvent.builder().type("department_card").departments(emotionDepts).build());
            events.add(AgentEvent.token("建议优先到「临床心理科」聊聊，也可以先到「全科医学科」评估。"
                    + ChatRules.EMOTION_CAVEAT));
            events.add(AgentEvent.caveat("本回答仅用于信息整理与就诊准备参考，不构成诊断或心理治疗建议。"
                    + "如果情绪困扰持续或加重，请尽快就医。"));
            return done(events, turnId, started, sessionSlots, sessionRound, false);
        }

        if (switched) {
            events.add(AgentEvent.plan("triage", "检测到新的主诉，已清空上一话题的症状信息，重新分诊",
                    List.of("triage")));
        }

        /* 追问连续性 */
        boolean continuingClarify = sessionRound > 0 && !switched;
        String decision;
        List<String> plannedAgents = List.of();
        if (continuingClarify) {
            events.add(AgentEvent.plan("triage", "继续采集症状信息（第 " + (sessionRound + 1) + " 轮）",
                    List.of("triage")));
            decision = "triage";
        } else if (!switched) {
            AgentOutput<SupervisorPayload> plan = supervisor.run(userQuestion,
                    llm.available() ? llm::plan : null);
            events.addAll(plan.getEvents());
            if (plan.getStatus().equals(AgentOutput.FAILED)
                    || plan.getStatus().equals(AgentOutput.BLOCKED)) {
                events.add(AgentEvent.caveat("AI 调度暂不可用，已切换到基础指引。请稍后重试或咨询门诊导诊台。"));
                return done(events, turnId, started, sessionSlots, sessionRound, true);
            }
            String d = plan.getPayload().getDecision();
            if ("multi".equals(d)) {
                plannedAgents = plan.getPayload().getAgents();
                decision = plannedAgents.isEmpty() ? "triage" : "multi";
            } else {
                decision = d;
            }
        } else {
            decision = "triage";
        }

        /* 按决策分发 */
        switch (decision == null ? "" : decision) {
            case "triage" -> sessionRound = runTriageBranch(text, sessionSlots, sessionRound, events);
            case "retrieve" -> runRetrievalBranch(text, events);
            case "schedule" -> runScheduleBranch(events);
            case "multi" -> runMultiBranch(text, plannedAgents, sessionSlots, sessionRound, events);
            case "done" -> {
                if (!injection.isEmpty()) events.add(AgentEvent.token(refusal));
                else events.add(AgentEvent.token("好的。有哪里不舒服，或者想确认该挂哪个科，随时告诉我。"));
            }
            default -> sessionRound = runTriageBranch(text, sessionSlots, sessionRound, events);
        }
        return done(events, turnId, started, sessionSlots, sessionRound, false);
    }

    /** 分诊分支 —— 对照 runTriageBranch */
    private int runTriageBranch(String text, Map<String, String> sessionSlots,
                                int sessionRound, List<AgentEvent> events) {
        AgentOutput<TriagePayload> out = triage.run(text, sessionSlots, sessionRound,
                // 有 Key 才注入模型分析；没有就是 null，TriageAgent 走关键词表 + 规则分
                llm.available() ? (t, r) -> llm.analyze(t, sessionSlots, r) : null);
        events.addAll(out.getEvents());

        // 合并槽位（过滤占位词）
        if (out.getPayload().getCollectedSymptoms() != null) {
            for (Map.Entry<String, String> e : out.getPayload().getCollectedSymptoms().entrySet()) {
                String v = e.getValue();
                if (v == null || v.trim().isEmpty() || chatRules.isPlaceholderValue(v)) continue;
                sessionSlots.put(e.getKey(), v.trim());
            }
        }
        if (out.getStatus().equals(AgentOutput.NEED_CLARIFY)) return sessionRound + 1;
        if (out.getStatus().equals(AgentOutput.BLOCKED)) return sessionRound;

        String answer = chatRules.summarizeTriage(out.getPayload().getDepartments());
        events.add(AgentEvent.token(answer));
        // Reviewer 审查
        ReviewerAgent.SafetyResult safe = reviewer.applySafetyRules(answer);
        if (safe.blocked()) {
            events.add(AgentEvent.token("\n\n这段内容涉及用药细节，超出本系统的能力范围。请直接咨询医生或药师。"));
        } else if (!safe.answer().equals(answer)) {
            events.add(AgentEvent.token("\n\n（修订：" + safe.answer() + "）"));
        }
        // 号源预览（只给预览，不下单）—— 号源查询细节由 scheduler 规则层提供时间轴
        String topDept = out.getPayload().getDepartments().isEmpty()
                ? null : out.getPayload().getDepartments().get(0).getName();
        if (topDept != null) {
            SchedulerIntentParser.BookingIntent intent = scheduler.parseBookingIntent(text);
            if (intent != null && intent.date() != null) {
                events.add(AgentEvent.caveat("已识别挂号意图：" + intent.department()
                        + "，预约日期 " + intent.date() + "。请点「去挂号」确认时段。"));
            }
        }
        return sessionRound;
    }

    /** 检索分支 —— 对照 runRetrievalBranch */
    private void runRetrievalBranch(String text, List<AgentEvent> events) {
        AgentOutput<RetrievalPayload> out = retrieval.run(text);
        events.addAll(out.getEvents());
        RetrievalPayload p = out.getPayload();
        if (out.getStatus().equals(AgentOutput.FAILED) || p.getSources().isEmpty()) {
            events.add(AgentEvent.token("这个问题我没在资料库里找到可靠依据。"
                    + "可以换个说法再问一次，或者直接咨询医生。"));
            return;
        }
        events.add(AgentEvent.token(p.getAnswer()));
        ReviewerAgent.SafetyResult reviewed = reviewer.applySafetyRules(p.getAnswer());
        if (reviewed.blocked()) {
            events.add(AgentEvent.token("这段内容涉及用药细节，超出本系统的能力范围。请直接咨询医生或药师。"));
            return;
        }
        /*
         * LLM-as-judge 补充防线（仅检索分支 —— 这里才有长答案与证据数）。
         *
         * 规则表是"已知越界表达"的黑名单，judge 能看出规则覆盖不到的新措辞
         * （比如换个说法下诊断）。所以规则优先、judge 只做加法：
         * 规则已经拦下的不重复处理，规则漏了而 judge 判 safety 很低时，
         * 追加一句提示而不是删答案 —— 抽取式作答的原文来自知识库，删掉反而丢证据。
         */
        if (llm.available()) {
            ReviewScores judged = llm.judge(reviewed.answer(), p.getSources().size());
            if (judged != null && judged.getSafety() < 0.5) {
                events.add(AgentEvent.caveat(
                        "这段回答经安全复核把握不大，请以医生面诊意见为准。"));
            }
        }
    }

    /** 排程分支 —— 对照 runScheduleBranch */
    private void runScheduleBranch(List<AgentEvent> events) {
        events.add(AgentEvent.token("号源查询请点页面上的「挂号」入口，选择院区和科室后查看可预约时段。"
                + "确认挂号需你本人操作，AI 不会替你占号。"));
    }

    /** multi 分支：按固定顺序串行执行 triage → retrieval */
    private void runMultiBranch(String text, List<String> plannedAgents,
                                Map<String, String> slots, int round, List<AgentEvent> events) {
        SupervisorAgent.MultiPlan plan = supervisor.resolveMultiPlan(plannedAgents);
        if (!plan.triage() && !plan.retrieval() && !plan.scheduleAlone()) {
            runTriageBranch(text, slots, round, events);
            return;
        }
        List<AgentEvent> triageBuf = new ArrayList<>();
        List<AgentEvent> retrievalBuf = new ArrayList<>();
        if (plan.triage()) runTriageBranch(text, slots, round, triageBuf);
        if (plan.retrieval()) runRetrievalBranch(text, retrievalBuf);
        events.addAll(triageBuf);
        boolean blocked = triageBuf.stream().anyMatch(e -> "emergency".equals(e.getType()));
        if (!blocked) events.addAll(retrievalBuf);
        if (plan.scheduleAlone()) runScheduleBranch(events);
    }

    private void runScheduleBranch(String text, List<AgentEvent> events) {
        runScheduleBranch(events);
    }

    private Map<String, Object> deptMap(String name, double conf, String reason) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", name);
        m.put("confidence", conf);
        m.put("reason", reason);
        return m;
    }

    /** 补 done 事件 */
    private TurnResult done(List<AgentEvent> events, String turnId, long started,
                            Map<String, String> slots, int round, boolean degraded) {
        Map<String, Object> session = new LinkedHashMap<>();
        session.put("slots", new HashMap<>(slots));
        session.put("round", round);
        events.add(AgentEvent.done(turnId, System.currentTimeMillis() - started, degraded, session));
        return new TurnResult(events, slots, (int) session.get("round"));
    }
}
