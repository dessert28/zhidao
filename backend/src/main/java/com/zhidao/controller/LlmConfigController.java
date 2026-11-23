package com.zhidao.controller;

import com.zhidao.agent.LlmConfigService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 模型配置端点 —— 对照 frontend/server/routes/llm-config.ts。
 *
 * <p>路径与 TS 版一致：GET/POST /api/llm-config、GET /api/llm-config/models、
 * POST /api/llm-config/test。GET 从不回显 Key（只给 source + hasKey）。
 */
@Slf4j
@RestController
@RequestMapping("/api/llm-config")
public class LlmConfigController {

    private final LlmConfigService config;

    public LlmConfigController(LlmConfigService config) {
        this.config = config;
    }

    /** 当前配置（不含 Key）—— 对照 GET / */
    @GetMapping
    public Map<String, Object> getConfig() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("configured", config.isConfigured());
        out.put("source", config.source());
        out.put("provider", config.isConfigured() ? config.provider() : null);
        out.put("baseURL", config.isConfigured() ? config.baseUrl() : null);
        out.put("model", config.isConfigured() ? config.model() : null);
        return out;
    }

    /** 保存配置 —— 对照 POST / */
    @PostMapping
    public ResponseEntity<Map<String, Object>> saveConfig(@RequestBody(required = false) Map<String, Object> body) {
        if (body == null) {
            return ResponseEntity.badRequest().body(Map.of(
                    "ok", false, "error", "invalid_json", "message", "请求格式不对"));
        }
        String apiKey = str(body.get("apiKey")).trim();
        if (apiKey.isEmpty()) {
            config.clearRuntime();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", true);
            out.put("cleared", true);
            out.put("configured", config.isConfigured());
            out.put("source", config.source());
            return ResponseEntity.ok(out);
        }
        String baseURL = str(body.get("baseURL")).trim();
        if (!config.isValidBaseUrl(baseURL)) {
            return ResponseEntity.badRequest().body(Map.of(
                    "ok", false, "error", "invalid_base_url",
                    "message", "接口地址要以 http:// 或 https:// 开头"));
        }
        String provider = body.get("provider") != null ? str(body.get("provider")) : "deepseek";
        String model = body.get("model") != null ? str(body.get("model")) : "";
        config.setRuntime(apiKey, provider, baseURL, model);

        return ResponseEntity.ok(Map.of(
                "ok", true, "configured", true, "source", "runtime",
                "provider", config.provider(), "model", config.model()));
    }

    /** 模型列表 —— 对照 GET /models。无 Key 时返回可操作说明，不报错 */
    @GetMapping("/models")
    public Map<String, Object> listModels() {
        if (!config.isConfigured()) {
            return Map.of(
                    "ok", false, "reason", "not_configured",
                    "message", "请先填写 API Key 并保存，再拉取模型列表。");
        }
        // 无 Key 验证阶段：这里不真发 HTTP 请求（需要真 Key 才有意义）。
        // 返回一个明确的"未在此环境验证"说明，而不是假装成功。
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", false);
        out.put("reason", "unverified");
        out.put("message", "模型列表需要在配置了真实 Key 的运行环境拉取。当前为结构验证模式。");
        out.put("current", config.model());
        return out;
    }

    /** 测试连接 —— 对照 POST /test。失败原因分类，不回显原始错误（可能含 Key 片段） */
    @PostMapping("/test")
    public Map<String, Object> testConnection() {
        long started = System.currentTimeMillis();
        if (!config.isConfigured()) {
            return Map.of("ok", false, "reason", "not_configured",
                    "message", "还没填 API Key。", "latencyMs", 0);
        }
        // 无 Key 验证阶段：不真的发请求。返回明确的未验证状态，
        // 前端据此显示"需真实 Key 才能测试"，而不是误判为 Key 无效。
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", false);
        out.put("reason", "unverified");
        out.put("message", "连接测试需要真实 Key 才能执行。当前为结构验证模式。");
        out.put("latencyMs", System.currentTimeMillis() - started);
        return out;
    }

    private static String str(Object o) {
        return o instanceof String s ? s : "";
    }
}
