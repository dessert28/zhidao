package com.zhidao.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * AI 端点支撑组件测试：Key 管理（不回显）、术语清洗、脱敏一致性。
 */
class AiEndpointsTest {

    private LlmConfigService config;
    private TermExplainer explainer;
    private ObjectMapper mapper;

    @BeforeEach
    void setUp() {
        config = new LlmConfigService();
        explainer = new TermExplainer(new RedactionService());
        mapper = new ObjectMapper();
    }

    @Test
    @DisplayName("Key 管理：初始未配置，runtime 设置后生效，清除后回退")
    void keyManagement() {
        assertFalse(config.isConfigured());
        assertEquals("none", config.source());

        config.setRuntime("sk-test-key-12345", "deepseek", "https://api.test.com/v1", "test-model");
        assertTrue(config.isConfigured());
        assertEquals("runtime", config.source());
        assertEquals("sk-test-key-12345", config.apiKey().orElseThrow());
        assertEquals("test-model", config.model());

        config.clearRuntime();
        assertFalse(config.isConfigured());
        assertEquals("none", config.source());
    }

    @Test
    @DisplayName("baseURL 校验：必须 http/https 开头")
    void baseUrlValidation() {
        assertTrue(config.isValidBaseUrl("https://api.deepseek.com/v1"));
        assertTrue(config.isValidBaseUrl("http://localhost:8080"));
        assertTrue(config.isValidBaseUrl(""));
        assertFalse(config.isValidBaseUrl("api.deepseek.com"));
    }

    @Test
    @DisplayName("术语清洗：过滤判断措辞、原文没有的词、过短解释")
    void sanitizeTerms() throws Exception {
        String text = "空腹血糖 7.2 mmol/L，糖化血红蛋白偏高";
        String json = """
                {"terms":[
                  {"term":"糖化血红蛋白","explanation":"反映过去两三个月平均血糖水平的指标"},
                  {"term":"空腹血糖","explanation":"这个结果很严重，建议立即治疗"},
                  {"term":"白细胞","explanation":"原文里根本没出现的词"},
                  {"term":"mmol/L","explanation":"短"}
                ]}
                """;
        var terms = explainer.sanitizeTerms(mapper.readTree(json), text, List.of());
        assertEquals(1, terms.size());
        assertEquals("糖化血红蛋白", terms.get(0).term());
    }

    @Test
    @DisplayName("术语清洗：known 词跳过、最多 6 条")
    void sanitizeKnownAndLimit() throws Exception {
        String text = "甲乙丙丁戊己庚辛壬癸都是术语";
        StringBuilder json = new StringBuilder("{\"terms\":[");
        for (char c : "甲乙丙丁戊己庚辛壬癸".toCharArray()) {
            if (json.length() > 11) json.append(",");
            json.append("{\"term\":\"").append(c).append("\",\"explanation\":\"这是").append(c).append("的字面含义说明\"}");
        }
        json.append("]}");
        var terms = explainer.sanitizeTerms(mapper.readTree(json.toString()), text, List.of("甲"));
        assertTrue(terms.size() <= 6);
        assertTrue(terms.stream().noneMatch(t -> t.term().equals("甲")));
    }
}
