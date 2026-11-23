package com.zhidao.agent;

import com.zhidao.agent.contract.AgentEvent;
import com.zhidao.agent.contract.AgentOutput;
import com.zhidao.agent.contract.SupervisorPayload;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * Supervisor —— 决策与路由，对照 frontend/server/agents/supervisor.ts。
 *
 * <p>三条硬约束：① 只能调三个会话工具，永不碰业务工具 ② reason 必填（前端展示"AI 在想什么"）
 * ③ 降级阶梯：LLM 计划坏 → 重试一次 → 规则路由；超时 → 规则路由。
 *
 * <p>规则路由、计划校验、冲突消解、multi 展开全是纯函数，逐字对齐 TS 版。
 * LLM 计划通过 planFn 注入（无 Key 时返回 null → 走规则路由）。
 */
@Slf4j
@Component
public class SupervisorAgent {

    private static final Pattern DEPT_WORDS = Pattern.compile("挂|预约|挂号|号源|排队|改约|取消|约个|约号");
    private static final Pattern SYMPTOM_WORDS = Pattern.compile(
            "疼|痛|酸|麻|胀|痒|晕|吐|拉|咳|喘|烧|发热|不舒服|难受|肿|出血|失眠|便秘");
    private static final Pattern KNOWLEDGE_WORDS = Pattern.compile(
            "是什么|为什么|怎么办|能不能|要不要|注意什么|吃什么|忌口|准备|科普");

    /** LLM 计划结果 */
    public record PlanResult(String decision, List<String> agents, String reason,
                             boolean requiresClarify, List<String> missing) {}

    /** 规则路由 —— 对照 routeByRules，顺序即优先级 */
    public SupervisorPayload routeByRules(String text) {
        String t = text == null ? "" : text.trim();
        if (DEPT_WORDS.matcher(t).find())
            return mk("schedule", List.of("scheduler"), "识别到挂号/预约意图，交由排程处理");
        if (SYMPTOM_WORDS.matcher(t).find())
            return mk("triage", List.of("triage"), "识别到症状描述，交由分诊采集槽位");
        if (KNOWLEDGE_WORDS.matcher(t).find())
            return mk("retrieve", List.of("retrieval"), "识别到知识性提问，交由循证检索");
        return mk("triage", List.of("triage"), "未识别明确意图，默认进入分诊采集");
    }

    private SupervisorPayload mk(String decision, List<String> agents, String reason) {
        return SupervisorPayload.builder().decision(decision).agents(agents).reason(reason)
                .requiresClarify(false).missing(List.of()).build();
    }

    /** 计划校验 —— 对照 parsePlan，非法返回 null */
    public SupervisorPayload parsePlan(Object raw) {
        if (!(raw instanceof Map<?, ?> o)) return null;
        Object decisionObj = o.get("decision");
        if (!(decisionObj instanceof String decision)
                || !SupervisorPayload.VALID_DECISIONS.contains(decision)) return null;
        Object reasonObj = o.get("reason");
        if (!(reasonObj instanceof String reason) || reason.trim().isEmpty()) return null;

        List<String> agents = new ArrayList<>();
        Object agentsObj = o.get("agents");
        if (agentsObj instanceof List<?> arr) {
            for (Object a : arr) {
                if (a instanceof String s && SupervisorPayload.VALID_AGENTS.contains(s) && !s.equals("supervisor")) {
                    agents.add(s);
                }
            }
        }
        if (!decision.equals("done") && agents.isEmpty()) return null;

        List<String> missing = new ArrayList<>();
        Object missingObj = o.get("missing");
        if (missingObj instanceof List<?> arr) {
            for (Object m : arr) if (m instanceof String s) missing.add(s);
        }
        return SupervisorPayload.builder()
                .decision(decision).agents(agents)
                .reason(reason.length() > 200 ? reason.substring(0, 200) : reason)
                .requiresClarify(Boolean.TRUE.equals(o.get("requiresClarify")))
                .missing(missing).build();
    }

    /** 冲突消解 —— 对照 serializeIfConflicting */
    public List<String> serializeIfConflicting(List<String> agents) {
        if (agents.size() <= 1) return agents;
        List<String> ordered = new ArrayList<>();
        for (String a : SupervisorPayload.SERIAL_ORDER) if (agents.contains(a)) ordered.add(a);
        for (String a : agents) if (!SupervisorPayload.SERIAL_ORDER.contains(a)) ordered.add(a);
        return ordered;
    }

    /** multi 计划展开 —— 对照 resolveMultiPlan */
    public record MultiPlan(boolean triage, boolean retrieval, boolean scheduleAlone) {}
    public MultiPlan resolveMultiPlan(List<String> agents) {
        Set<String> wanted = new HashSet<>();
        for (String a : agents) {
            if (a.equals("triage") || a.equals("retrieval") || a.equals("scheduler")) wanted.add(a);
        }
        boolean triage = wanted.contains("triage");
        return new MultiPlan(triage, wanted.contains("retrieval"),
                wanted.contains("scheduler") && !triage);
    }

    /** 工具越界审计 —— 对照 auditSupervisorTools */
    private static final List<String> SUPERVISOR_TOOLS =
            List.of("get_session_state", "get_user_profile", "resume_pending_task");
    public List<String> auditSupervisorTools(List<String> used) {
        List<String> bad = new ArrayList<>();
        for (String t : used) if (!SUPERVISOR_TOOLS.contains(t)) bad.add(t);
        return bad;
    }

    /**
     * 主处理 —— 对照 makeSupervisor.handle。
     *
     * @param text   用户输入
     * @param planFn LLM 计划函数，输入 (text, retryHint) 返回结构化计划；null=纯规则
     */
    public AgentOutput<SupervisorPayload> run(String text, PlanFn planFn) {
        SupervisorPayload parsed = null;
        if (planFn != null) {
            try {
                Object first = planFn.apply(text, false);
                parsed = parsePlan(first);
                /*
                 * 只有"模型回了、但不合格"才值得带着提示再问一次。
                 * first == null 表示调用失败/超时 —— 再问一次就是再等一个超时窗口，
                 * 实测把一轮对话从 12 秒拖成 24 秒，用户感知是卡死而不是降级。
                 */
                if (first != null && parsed == null) {
                    Object second = planFn.apply(text, true);
                    parsed = parsePlan(second);
                }
            } catch (Exception e) {
                log.warn("[调度] LLM 计划失败，走规则路由: {}", e.getMessage());
                parsed = null;
            }
        }

        SupervisorPayload plan = parsed != null ? parsed : routeByRules(text);
        List<AgentEvent> events = List.of(
                AgentEvent.plan(plan.getDecision(), plan.getReason(), plan.getAgents()));
        Map<String, Object> degraded = parsed == null
                ? AgentOutput.degrade("supervisor", "llm plan invalid", "rule-routing") : null;

        return AgentOutput.<SupervisorPayload>builder()
                .status(plan.isRequiresClarify() ? AgentOutput.NEED_CLARIFY : AgentOutput.OK)
                .payload(plan)
                .confidence(parsed != null ? 0.85 : 0.6)
                .evidence(List.of())
                .events(events)
                .degraded(degraded)
                .build();
    }

    public AgentOutput<SupervisorPayload> run(String text) {
        return run(text, null);
    }

    /** LLM 计划函数：retryHint=true 时提示上次输出非法 */
    public interface PlanFn {
        Object apply(String text, boolean retryHint);
    }
}
