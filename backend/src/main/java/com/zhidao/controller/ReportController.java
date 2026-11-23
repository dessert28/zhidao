package com.zhidao.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhidao.agent.ChatClientFactory;
import com.zhidao.agent.LlmConfigService;
import com.zhidao.agent.RedactionService;
import com.zhidao.agent.TermExplainer;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.*;

/**
 * 报告术语补词端点 —— 对照 frontend/server/routes/report.ts 的 POST /terms。
 *
 * <p>只做「术语 → 白话」，不生成结论。模型输出经两级约束：
 * prompt 禁止判断措辞（TermExplainer.SYSTEM_PROMPT）+ 结果过滤（sanitizeTerms）。
 * 无 Key 时返回 no_model（前端退回内置词库），与 TS 版降级行为一致。
 */
@Slf4j
@RestController
@RequestMapping("/api/report")
public class ReportController {

    private final ChatClientFactory clientFactory;
    private final LlmConfigService config;
    private final TermExplainer explainer;
    private final RedactionService redaction;
    private final ObjectMapper objectMapper;

    public ReportController(ChatClientFactory clientFactory, LlmConfigService config,
                            TermExplainer explainer, RedactionService redaction,
                            ObjectMapper objectMapper) {
        this.clientFactory = clientFactory;
        this.config = config;
        this.explainer = explainer;
        this.redaction = redaction;
        this.objectMapper = objectMapper;
    }

    public record TermsBody(String text, List<String> known) {}

    @PostMapping("/terms")
    public ResponseEntity<Map<String, Object>> terms(@RequestBody(required = false) TermsBody body) {
        if (body == null || body.text() == null || body.text().trim().isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "ok", false, "reason", "bad_input", "message", "缺少报告正文"));
        }
        String text = body.text().trim();
        List<String> known = body.known() == null ? List.of() : body.known().stream()
                .filter(Objects::nonNull).limit(40).toList();

        // 无 Key：结构化降级，不报错
        if (!config.isConfigured() || clientFactory.create().isEmpty()) {
            return ResponseEntity.ok(Map.of(
                    "ok", false, "reason", "no_model", "message", "未配置模型，当前只用内置词库"));
        }

        String clipped = text.substring(0, Math.min(4000, text.length()));
        String prompt = "报告原文：\n" + clipped + "\n\n"
                + "以下词已经解释过，不要重复：" + (known.isEmpty() ? "无" : String.join("、", known))
                + "\n请列出原文中其余普通人不理解的专业术语及字面含义。"
                + "\n只返回 JSON：{\"terms\":[{\"term\":\"...\",\"explanation\":\"...\"}]}";

        try {
            String answer = clientFactory.create().get().prompt()
                    .system(TermExplainer.SYSTEM_PROMPT)
                    .user(prompt)
                    .call().content();
            if (answer == null || answer.isBlank()) {
                return ResponseEntity.ok(Map.of(
                        "ok", false, "reason", "failed", "message", "模型调用失败，可稍后再试"));
            }
            JsonNode parsed = extractJson(answer);
            List<TermExplainer.AiTerm> terms = explainer.sanitizeTerms(parsed, clipped, known);
            return ResponseEntity.ok(Map.of("ok", true, "terms", terms));
        } catch (Exception e) {
            // 只记原因，不记正文（隐私边界）
            log.warn("[report] 术语补词未完成: {}", e.getMessage());
            return ResponseEntity.ok(Map.of(
                    "ok", false, "reason", "failed", "message", "模型调用失败，可稍后再试"));
        }
    }

    /** 从模型输出里抠出 JSON 对象（模型常带 ```json 包裹或前后说明文字） */
    private JsonNode extractJson(String answer) {
        String s = answer.trim();
        int start = s.indexOf('{');
        int end = s.lastIndexOf('}');
        if (start < 0 || end <= start) return objectMapper.createObjectNode();
        try {
            return objectMapper.readTree(s.substring(start, end + 1));
        } catch (Exception e) {
            return objectMapper.createObjectNode();
        }
    }
}
