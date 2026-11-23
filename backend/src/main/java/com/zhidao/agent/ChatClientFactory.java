package com.zhidao.agent;

import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.api.OpenAiApi;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * ChatClient 工厂 —— 按当前生效的 Key 配置动态构造客户端。
 *
 * <p>这是迁移后统一 Key 来源的关键：TS 版三个 AI 端点（chat/report/ocr）
 * 都读 BFF 的同一份 runtime 配置；Java 侧如果各造各的 ChatClient
 * （像最小验证那样读独立环境变量），用户在上填的 Key 就只对部分端点生效。
 * 这里统一从 {@link LlmConfigService} 取当前有效配置，runtime 优先、环境变量回退。
 *
 * <p>每次调用构造新客户端（OpenAiApi 很轻），换来的是"Key 一改全链路生效"，
 * 且无需在 Key 变更时管理单例缓存的失效。
 */
@Slf4j
@Component
public class ChatClientFactory {

    private final LlmConfigService config;

    public ChatClientFactory(LlmConfigService config) {
        this.config = config;
    }

    /** 当前是否有可用客户端（没配 Key 时为 empty） */
    public Optional<ChatClient> create() {
        Optional<String> key = config.apiKey();
        if (key.isEmpty()) return Optional.empty();
        try {
            // 注意参数顺序：Spring AI 的两参构造是 (baseUrl, apiKey)，不是 (apiKey, baseUrl)。
            // 传反了不会报错 —— 它会拿 Key 当域名去发请求，报 UnknownHost 而不是认证失败，
            // 排查起来很容易误以为是 Key 无效。真机验证时踩过这个坑，这里写明。
            // 地址用 normalizedBaseUrl()：OpenAiApi 自己拼 /v1/...，用户写成 .../v1 也不会双段。
            OpenAiApi api = new OpenAiApi(config.normalizedBaseUrl(), key.get());
            OpenAiChatModel model = new OpenAiChatModel(api,
                    org.springframework.ai.openai.OpenAiChatOptions.builder()
                            .model(config.model())
                            .temperature(0.1)
                            .build());
            return Optional.of(ChatClient.create(model));
        } catch (Exception e) {
            // 构造失败不让整个端点崩 —— 降级为"模型不可用"，由调用方给结构化提示
            log.warn("[ChatClient] 构造失败: {}", e.getMessage());
            return Optional.empty();
        }
    }
}
