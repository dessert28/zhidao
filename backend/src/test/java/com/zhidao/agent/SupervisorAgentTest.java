package com.zhidao.agent;

import com.zhidao.agent.contract.AgentOutput;
import com.zhidao.agent.contract.SupervisorPayload;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class SupervisorAgentTest {

    private SupervisorAgent agent;

    @BeforeEach
    void setUp() {
        agent = new SupervisorAgent();
    }

    @Test
    @DisplayName("规则路由：挂号→schedule，症状→triage，知识→retrieve，兜底→triage")
    void ruleRouting() {
        assertEquals("schedule", agent.routeByRules("我要挂号预约").getDecision());
        assertEquals("triage", agent.routeByRules("我头疼发烧").getDecision());
        assertEquals("retrieve", agent.routeByRules("血糖高要注意什么").getDecision());
        assertEquals("triage", agent.routeByRules("随便说点什么").getDecision());
    }

    @Test
    @DisplayName("规则路由 reason 与 TS 版逐字一致")
    void ruleReasonExact() {
        assertEquals("识别到挂号/预约意图，交由排程处理", agent.routeByRules("我要挂号预约").getReason());
        assertEquals("未识别明确意图，默认进入分诊采集", agent.routeByRules("随便说点什么").getReason());
    }

    @Test
    @DisplayName("无 LLM 时 run 走规则路由，带降级标记，confidence=0.6")
    void runWithoutLlm() {
        AgentOutput<SupervisorPayload> out = agent.run("我要挂号预约");
        assertEquals(AgentOutput.OK, out.getStatus());
        assertEquals("schedule", out.getPayload().getDecision());
        assertEquals(0.6, out.getConfidence(), 0.001);
        assertNotNull(out.getDegraded());
        assertEquals("rule-routing", out.getDegraded().get("fallback"));
        assertTrue(out.getEvents().stream().anyMatch(e -> "plan".equals(e.getType())));
    }

    @Test
    @DisplayName("计划校验：合法计划通过，非法返回 null")
    void parsePlan() {
        SupervisorPayload ok = agent.parsePlan(Map.of(
                "decision", "triage", "reason", "用户描述症状", "agents", List.of("triage")));
        assertNotNull(ok);
        assertEquals("triage", ok.getDecision());

        assertNull(agent.parsePlan(Map.of("decision", "bogus", "reason", "x", "agents", List.of("triage"))));
        assertNull(agent.parsePlan(Map.of("decision", "triage", "reason", "", "agents", List.of("triage"))));
        // 除 done 外必须有子 agent
        assertNull(agent.parsePlan(Map.of("decision", "triage", "reason", "x", "agents", List.of())));
    }

    @Test
    @DisplayName("LLM 计划合法时 confidence=0.85 且无降级")
    void runWithValidLlmPlan() {
        AgentOutput<SupervisorPayload> out = agent.run("随便", (text, retry) ->
                Map.of("decision", "retrieve", "reason", "模型判断", "agents", List.of("retrieval")));
        assertEquals(0.85, out.getConfidence(), 0.001);
        assertEquals("retrieve", out.getPayload().getDecision());
        assertNull(out.getDegraded());
    }

    @Test
    @DisplayName("坏 JSON 重试一次后仍非法 → 规则兜底")
    void retryThenFallback() {
        AgentOutput<SupervisorPayload> out = agent.run("我头疼", (text, retry) ->
                Map.of("decision", "garbage", "reason", "x"));
        assertEquals("triage", out.getPayload().getDecision());
        assertEquals(0.6, out.getConfidence(), 0.001);
    }

    @Test
    @DisplayName("冲突消解：triage→retrieval→scheduler 固定顺序")
    void serialize() {
        assertEquals(List.of("triage", "retrieval", "scheduler"),
                agent.serializeIfConflicting(List.of("scheduler", "retrieval", "triage")));
    }

    @Test
    @DisplayName("multi 展开：scheduler 与 triage 同在时不单独跑排程")
    void multiPlan() {
        SupervisorAgent.MultiPlan p = agent.resolveMultiPlan(List.of("triage", "scheduler", "retrieval"));
        assertTrue(p.triage());
        assertTrue(p.retrieval());
        assertFalse(p.scheduleAlone(), "triage 内部已查号源，不重复跑");

        SupervisorAgent.MultiPlan p2 = agent.resolveMultiPlan(List.of("scheduler"));
        assertTrue(p2.scheduleAlone(), "只有 scheduler 时才单独跑");
    }

    @Test
    @DisplayName("工具越界审计：业务工具被拦下")
    void toolAudit() {
        assertEquals(List.of("create_order"),
                agent.auditSupervisorTools(List.of("get_session_state", "create_order")));
        assertTrue(agent.auditSupervisorTools(List.of("get_user_profile", "resume_pending_task")).isEmpty());
    }
}
