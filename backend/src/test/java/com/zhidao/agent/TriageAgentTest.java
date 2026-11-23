package com.zhidao.agent;

import com.zhidao.agent.contract.AgentOutput;
import com.zhidao.agent.contract.TriagePayload;
import com.zhidao.agent.rules.RedFlagRule;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Triage Agent 规则路径对照测试 —— 期望值来自 TS 版 makeTriage 实测输出。
 */
class TriageAgentTest {

    private TriageAgent agent;

    @BeforeEach
    void setUp() {
        agent = new TriageAgent(new RedFlagRule());
    }

    @Test
    @DisplayName("红线短路：胸口疼 → blocked")
    void redFlagBlocks() {
        AgentOutput<TriagePayload> out = agent.run("胸口疼得厉害");
        assertEquals(AgentOutput.BLOCKED, out.getStatus());
        assertNotNull(out.getPayload().getRedFlag());
        assertEquals("chest_pain", out.getPayload().getRedFlag().getType());
        assertEquals(1.0, out.getConfidence(), 0.001);
        assertTrue(out.getEvents().stream().anyMatch(e -> "emergency".equals(e.getType())));
    }

    @Test
    @DisplayName("咳嗽好几天 → 呼吸内科，槽位+置信度对齐")
    void coughDays() {
        AgentOutput<TriagePayload> out = agent.run("我咳嗽好几天了");
        assertEquals(AgentOutput.OK, out.getStatus());
        assertEquals("几天", out.getPayload().getCollectedSymptoms().get("时长"));
        assertEquals("咳嗽", out.getPayload().getCollectedSymptoms().get("性质"));
        assertEquals(1, out.getPayload().getDepartments().size());
        assertEquals("呼吸内科", out.getPayload().getDepartments().get(0).getName());
        assertEquals(0.58, out.getConfidence(), 0.001);
    }

    @Test
    @DisplayName("血糖高要去哪个科 → 纯指标短路，低置信触发兜底加两科")
    void labIndicatorQuery() {
        AgentOutput<TriagePayload> out = agent.run("血糖高要去哪个科");
        assertEquals(AgentOutput.OK, out.getStatus());
        // 纯指标查询：不问部位时长
        assertTrue(agent.missingSlots(agent.extractSlots("血糖高要去哪个科"), "血糖高要去哪个科").isEmpty());
        assertEquals(3, out.getPayload().getDepartments().size());
        assertEquals("内分泌科", out.getPayload().getDepartments().get(0).getName());
        assertEquals("全科医学科", out.getPayload().getDepartments().get(1).getName());
        assertEquals("门诊导诊台", out.getPayload().getDepartments().get(2).getName());
        assertEquals(0.22, out.getConfidence(), 0.001);
    }

    @Test
    @DisplayName("最近有点头晕 → 模糊时长仍追问，need_clarify")
    void vagueTimeClarify() {
        AgentOutput<TriagePayload> out = agent.run("最近有点头晕");
        assertEquals(AgentOutput.NEED_CLARIFY, out.getStatus());
        assertEquals("最近", out.getPayload().getCollectedSymptoms().get("时长"));
        assertEquals("这个情况大概多久了？几个小时，还是好几天了？", out.getPayload().getNextQuestion());
        assertEquals(0.86, out.getConfidence(), 0.001);
    }

    @Test
    @DisplayName("我想挂个号 → 缺部位时长，一次问两个")
    void vagueComplaint() {
        AgentOutput<TriagePayload> out = agent.run("我想挂个号");
        assertEquals(AgentOutput.NEED_CLARIFY, out.getStatus());
        assertEquals(List.of("部位", "时长"),
                agent.missingSlots(agent.extractSlots("我想挂个号"), "我想挂个号"));
        assertEquals("具体是哪个位置不舒服？比如额头、胸口、肚子左边？\n"
                + "这个情况大概多久了？几个小时，还是好几天了？", out.getPayload().getNextQuestion());
        assertEquals(0.12, out.getConfidence(), 0.001);
    }

    @Test
    @DisplayName("多轮槽位合并：后到的非空值覆盖先前")
    void mergeSlots() {
        Map<String, String> base = Map.of("部位", "头", "时长", "三天");
        Map<String, String> next = Map.of("性质", "疼", "时长", "");
        Map<String, String> merged = agent.mergeSlots(base, next);
        assertEquals("三天", merged.get("时长"), "空值不覆盖");
        assertEquals("疼", merged.get("性质"));
    }

    @Test
    @DisplayName("科室规则：多规则命中取前三个")
    void deptRulesTop3() {
        List<TriagePayload.Department> depts = agent.guessDepartments(Map.of(), "胸闷咳嗽胃痛头晕");
        assertTrue(depts.size() <= 3);
        assertTrue(depts.stream().anyMatch(d -> d.getName().equals("心血管内科")));
    }
}
