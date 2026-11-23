package com.zhidao.agent;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * 模型配置服务 —— 对照 frontend/server/llm/client.ts 的 runtime 配置部分。
 *
 * <p>安全边界（与 TS 版一致）：
 * <ol>
 *   <li>服务端不持久化 Key —— 只放进程内存，重启即忘
 *   <li>任何能访问页面的人都能改配置 —— 演示优先的取舍，公网部署前须知
 *   <li>接口从不回显 Key —— 只返回 provider/model/baseURL 和 hasKey
 * </ol>
 *
 * <p>Key 来源优先级：runtime（用户填的） > 环境变量（ZHIDAO_LLM_API_KEY） > 无。
 * 这统一了迁移后 chat 端点与配置端点的 Key 来源 —— 迁移前它们分别在
 * BFF 内存和 .env 两处。
 */
@Slf4j
@Service
public class LlmConfigService {

    /** 运行时配置（内存态） */
    private static class RuntimeConfig {
        final String apiKey;
        final String provider;
        final String baseURL;
        final String model;

        RuntimeConfig(String apiKey, String provider, String baseURL, String model) {
            this.apiKey = apiKey;
            this.provider = provider;
            this.baseURL = baseURL;
            this.model = model;
        }
    }

    private volatile RuntimeConfig runtime = null;

    @Value("${zhidao.llm.api-key:${ZHIDAO_LLM_API_KEY:}}")
    private String envApiKey;

    @Value("${zhidao.llm.base-url:https://api.deepseek.com/v1}")
    private String envBaseUrl;

    @Value("${zhidao.llm.model:deepseek-chat}")
    private String envModel;

    private static final Pattern URL_PATTERN = Pattern.compile("^https?://", Pattern.CASE_INSENSITIVE);

    /** 当前生效的 Key（runtime 优先，回退环境变量） */
    public Optional<String> apiKey() {
        if (runtime != null && !runtime.apiKey.isEmpty()) return Optional.of(runtime.apiKey);
        if (envApiKey != null && !envApiKey.isBlank()) return Optional.of(envApiKey);
        return Optional.empty();
    }

    public boolean isConfigured() {
        return apiKey().isPresent();
    }

    /** 配置来源：runtime | env | none */
    public String source() {
        if (runtime != null) return "runtime";
        if (envApiKey != null && !envApiKey.isBlank()) return "env";
        return "none";
    }

    /** 当前生效的基础地址 */
    public String baseUrl() {
        return runtime != null && !runtime.baseURL.isEmpty() ? runtime.baseURL : envBaseUrl;
    }

    /** 当前生效的模型名 */
    public String model() {
        return runtime != null && !runtime.model.isEmpty() ? runtime.model : envModel;
    }

    /**
     * 归一化后的基础地址 —— 构造 OpenAiApi / 拼接 /models 时用。
     *
     * <p>Spring AI 的 OpenAiApi 会自己在 baseUrl 后拼 {@code /v1/chat/completions}，
     * 所以 baseUrl 只能是域名部分。但用户（以及旧版 .env）习惯写成
     * {@code https://api.deepseek.com/v1} —— 直接传进去会变成 {@code /v1/v1/...}，
     * 报 404 却看不出原因。这里统一去掉尾部斜杠与结尾的 /v1，
     * 让两种写法都能用，而不是要求用户记住这个坑。
     */
    public String normalizedBaseUrl() {
        String b = baseUrl() == null ? "" : baseUrl().trim();
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        if (b.endsWith("/v1")) b = b.substring(0, b.length() - 3);
        return b;
    }

    /** 各家的默认网关与默认模型 —— 对照 llm/client.ts 的 PRESETS。都走 OpenAI 兼容协议 */
    private static final Map<String, String[]> PRESETS = Map.of(
            "deepseek", new String[]{"https://api.deepseek.com", "deepseek-chat"},
            "openai", new String[]{"https://api.openai.com", "gpt-4o-mini"},
            "qwen", new String[]{"https://dashscope.aliyuncs.com/compatible-mode", "qwen-plus"},
            "moonshot", new String[]{"https://api.moonshot.cn", "moonshot-v1-8k"},
            "ollama", new String[]{"http://localhost:11434", "qwen2.5:7b"}
    );

    /** 设置运行时配置（不落盘、不记日志） */
    public void setRuntime(String apiKey, String provider, String baseURL, String model) {
        String p = provider == null ? "" : provider.trim().toLowerCase();
        String[] preset = PRESETS.getOrDefault(p, PRESETS.get("deepseek"));
        /*
         * 用户只填 Key 是常态（设置页允许留空地址与模型名）。
         * 留空就按 provider 的预设补齐 —— 否则选 openai 却仍然打 DeepSeek 的地址，
         * 表现是"Key 正确但 401"，而界面上一切都正常。
         */
        String base = (baseURL == null || baseURL.isBlank()) ? preset[0] : baseURL.trim();
        String m = (model == null || model.isBlank()) ? preset[1] : model.trim();
        this.runtime = new RuntimeConfig(apiKey.trim(), p.isEmpty() ? "deepseek" : p, base, m);
    }

    /** 清除运行时配置，回到环境变量 */
    public void clearRuntime() {
        this.runtime = null;
    }

    public boolean hasRuntime() {
        return runtime != null;
    }

    public String provider() {
        return runtime != null ? runtime.provider : "env";
    }

    /** baseURL 格式校验 —— 对照 llm-config.ts 的校验 */
    public boolean isValidBaseUrl(String baseURL) {
        return baseURL == null || baseURL.isEmpty() || URL_PATTERN.matcher(baseURL).find();
    }
}
