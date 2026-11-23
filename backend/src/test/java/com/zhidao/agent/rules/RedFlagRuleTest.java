package com.zhidao.agent.rules;

import com.zhidao.agent.contract.RedFlag;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 红线规则引擎测试 —— 用例逐条来自 TS 版 red-flag.test.ts。
 * 这是"AI 安全"最硬的证据，必须全绿。
 */
class RedFlagRuleTest {

    private final RedFlagRule engine = new RedFlagRule();

    @Test
    @DisplayName("规则表至少 5 条")
    void ruleCount() {
        assertTrue(engine.ruleCount() >= 5);
    }

    @Test
    @DisplayName("16 个急症表述全部命中且类型正确")
    void allEmergencyCases() {
        Map<String, String> cases = new java.util.LinkedHashMap<>();
        cases.put("胸口疼得厉害", "chest_pain");
        cases.put("这两天胸痛", "chest_pain");
        cases.put("感觉心口窝闷", "chest_pain");
        cases.put("早上起来嘴角歪了", "stroke");
        cases.put("一侧手脚没力气", "stroke");
        cases.put("半边身子使不上劲", "stroke");
        cases.put("左边手脚发麻", "stroke");
        cases.put("说话含糊不清", "stroke");
        cases.put("晚上喘不上气", "dyspnea");
        cases.put("走两步就呼吸困难", "dyspnea");
        cases.put("老人叫不醒了", "consciousness");
        cases.put("突然晕倒", "consciousness");
        cases.put("抽风了一次", "consciousness");
        cases.put("呕血了", "hemorrhage");
        cases.put("大出血止不住", "hemorrhage");
        cases.put("黑便三天", "hemorrhage");

        for (Map.Entry<String, String> e : cases.entrySet()) {
            RedFlagRule.RedFlagResult r = engine.check(e.getKey());
            assertNotNull(r.hit(), "应命中: " + e.getKey());
            assertEquals(e.getValue(), r.hit().getType(), "类型不符: " + e.getKey());
            assertTrue(r.hit().getGuidance().length() > 10, "guidance 过短: " + e.getKey());
        }
    }

    @Test
    @DisplayName("诊断名也命中（急性心梗）")
    void diagnosisNameHits() {
        assertNotNull(engine.recheckAnswer("你这种情况可能是胸痛引起的心梗"));
        assertNotNull(engine.check("考虑急性心肌梗死，需要立刻手术").hit());
        assertNotNull(engine.check("急性冠脉综合征发作").hit());
    }

    @Test
    @DisplayName("5 个普通描述不误报")
    void noFalsePositive() {
        List<String> safe = List.of(
                "我想挂个号",
                "血糖高要注意什么",
                "最近有点失眠",
                "这个指标比半年前下降了 15%",
                "明天上午有空吗");
        for (String text : safe) {
            assertNull(engine.check(text).hit(), "不应误报: " + text);
        }
    }

    @Test
    @DisplayName("多重命中返回第一条但记下全部类型")
    void multipleHits() {
        RedFlagRule.RedFlagResult r = engine.check("突然胸痛而且喘不上气");
        assertNotNull(r.hit());
        assertTrue(r.matchedTypes().size() >= 2, "应记录多个类型: " + r.matchedTypes());
    }

    @Test
    @DisplayName("guidance 是可执行动作（含 120/急诊/拨）")
    void guidanceIsActionable() {
        RedFlag hit = engine.check("胸痛").hit();
        assertNotNull(hit);
        assertTrue(hit.getGuidance().matches(".*(120|急诊|拨).*"));
    }

    @Test
    @DisplayName("复检：普通建议不触发")
    void recheckNormalAdvice() {
        assertNull(engine.recheckAnswer("建议挂心内科门诊"));
    }
}
