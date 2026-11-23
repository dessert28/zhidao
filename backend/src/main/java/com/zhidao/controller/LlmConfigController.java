package com.zhidao.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhidao.agent.ChatClientFactory;
import com.zhidao.agent.LlmConfigService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.openai.api.ResponseFormat;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestClient;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 模型配置端点 —— 对照 frontend/server/routes/llm-config.ts。
 *
 * <p>路径与 TS 版一致：GET/POST /api/llm-config、GET /api/llm-config/models、
 * POST /api/llm-config/test。GET 从不回显 Key（只给 source + configured）。
 */
@Slf4j
@RestController
@RequestMapping("/api/llm-config")
public class LlmConfigController {

    private final LlmConfigService config;
    private final ChatClientFactory clientFactory;
    private final ObjectMapper objectMapper;

    public LlmConfigController(LlmConfigService config, ChatClientFactory clientFactory,
                               ObjectMapper objectMapper) {
        this.config = config;
        this.clientFactory = clientFactory;
        this.objectMapper = objectMapper;
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

    /**
     * 模型列表 —— 拉 {@code {base}/v1/models}。
     *
     * <p>用标准 OpenAI 兼容端点而不是维护硬编码表：服务商上新模型自动就有，
     * 也不会推荐一个已经下线的名字。但不是所有兼容实现都提供 /models（有的 404），
     * 那种情况返回 unsupported，界面让用户手填模型名 —— 所以这里允许失败。
     */
    @GetMapping("/models")
    public Map<String, Object> listModels() {
        if (!config.isConfigured()) {
            return Map.of(
                    "ok", false, "reason", "not_configured",
                    "message", "请先填写 API Key 并保存，再拉取模型列表。");
        }
        String url = config.normalizedBaseUrl() + "/v1/models";
        try {
            // 设超时：这是用户点一下就要出结果的按钮，不能因为网络挂住而一直转圈
            org.springframework.http.client.SimpleClientHttpRequestFactory factory =
                    new org.springframework.http.client.SimpleClientHttpRequestFactory();
            factory.setConnectTimeout(5000);
            factory.setReadTimeout(10000);
            String body = RestClient.builder().requestFactory(factory).build()
                    .get().uri(url)
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + config.apiKey().orElse(""))
                    .header(HttpHeaders.ACCEPT, "application/json")
                    .retrieve().body(String.class);

            JsonNode root = objectMapper.readTree(body == null || body.isBlank() ? "{}" : body);
            List<String> models = new ArrayList<>();
            for (JsonNode n : root.path("data")) {
                String id = n.path("id").asText("");
                if (!id.isBlank()) models.add(id);
            }
            if (models.isEmpty()) {
                return Map.of("ok", false, "reason", "unsupported",
                        "message", "接口没有返回任何模型，请手动填写模型名。");
            }
            models.sort(Comparator.naturalOrder());
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", true);
            out.put("models", models);
            out.put("current", config.model());
            return out;
        } catch (HttpStatusCodeException e) {
            // 401/403 是 Key 的问题，404 是"这家没实现 /models"，两者修法完全不同
            int status = e.getStatusCode().value();
            String reason = (status == 401 || status == 403) ? "auth"
                    : status == 404 ? "unsupported" : "unreachable";
            log.warn("[llm-config] 拉取模型列表失败 status={}", status);
            return Map.of("ok", false, "reason", reason,
                    "message", (status == 401 || status == 403) ? "API Key 无效或没有权限。"
                            : status == 404 ? "这个服务商没有提供模型列表接口，请手动填写模型名。"
                            : "接口返回 " + status + "，请检查接口地址。");
        } catch (Exception e) {
            // 只记异常类型，避免把含 Key 片段的信息带进日志
            log.warn("[llm-config] 拉取模型列表异常 type={}", e.getClass().getSimpleName());
            return Map.of("ok", false, "reason", "unreachable",
                    "message", "连不上接口地址，请检查网络或 baseURL。");
        }
    }

    /**
     * 测试连接 —— 对照 TS 版 probeLlm。
     *
     * <p>必须探<b>结构化输出</b>而不是纯文本：实测 DeepSeek V4 思考模式下
     * maxTokens 被 reasoning 吃光、content 是空字符串，纯文本探测会显示"正常"，
     * 而业务链路（全部走 JSON 模式）一直在静默降级 —— 探错对象等于没测。
     */
    @PostMapping("/test")
    public Map<String, Object> testConnection() {
        long started = System.currentTimeMillis();
        if (!config.isConfigured()) {
            return Map.of("ok", false, "reason", "not_configured",
                    "message", "还没填 API Key。", "latencyMs", 0);
        }
        Optional<ChatClient> client = clientFactory.create();
        if (client.isEmpty()) {
            return Map.of("ok", false, "reason", "unsupported",
                    "message", "客户端构造失败，请检查接口地址。", "latencyMs", 0);
        }
        try {
            String raw = client.get().prompt()
                    .system("你是一个连通性探针，只按 schema 输出 JSON，不要有多余的话。")
                    .user("返回 JSON 对象：{\"reply\":\"收到\"}")
                    .options(OpenAiChatOptions.builder()
                            .model(config.model())
                            .temperature(0d)
                            .responseFormat(new ResponseFormat(ResponseFormat.Type.JSON_OBJECT, (String) null))
                            .build())
                    .call().content();
            long cost = System.currentTimeMillis() - started;
            if (raw == null || !raw.contains("收到")) {
                return Map.of("ok", false, "reason", "bad-output",
                        "message", "模型连通但没返回预期结构，可能不支持 JSON 输出模式。",
                        "latencyMs", cost);
            }
            // 文案与 TS 版一致：设置页直接把 message 显示给用户
            return Map.of("ok", true, "latencyMs", cost,
                    "model", config.model(), "text", raw.trim(),
                    "message", "连接正常，模型 " + config.model() + " 响应了 " + cost + "ms。");
        } catch (Exception e) {
            long cost = System.currentTimeMillis() - started;
            String msg = String.valueOf(e.getMessage()).toLowerCase(java.util.Locale.ROOT);
            boolean auth = msg.contains("401") || msg.contains("403")
                    || msg.contains("unauthorized") || msg.contains("invalid api key")
                    || msg.contains("authentication");
            boolean badOutput = msg.contains("json") || msg.contains("response_format")
                    || msg.contains("parse") || msg.contains("schema");
            log.warn("[llm-config] 连接测试失败 type={}", e.getClass().getSimpleName());
            return Map.of("ok", false,
                    "reason", auth ? "auth" : badOutput ? "bad-output" : "network",
                    "message", auth ? "API Key 无效或没有权限。"
                            : badOutput ? "模型不支持 JSON 输出模式。"
                            : "连不上模型服务，请检查网络或接口地址。",
                    "latencyMs", cost);
        }
    }

    private static String str(Object o) {
        return o instanceof String s ? s : "";
    }
}
