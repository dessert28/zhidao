package com.zhidao.ai;

import com.zhidao.common.ApiResult;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * AI 接入最小验证端点 —— 课设"后端用 Spring AI 接入了模型"的证据。
 *
 * <p><b>它做什么：</b>一个 GET 请求，证明 Spring Boot 这一侧能真正调通一个
 * OpenAI 兼容模型。仅此而已 —— 不做分诊、不做 RAG、不做 SSE，那些仍在
 * frontend 的 Node BFF（比赛侧评分证据链所在），一层都不搬。
 *
 * <p><b>三条边界，逐条对应项目的既有承诺：</b>
 * <ol>
 *   <li><b>无 Key 也能跑</b>：没配 Key 时 {@link #chatClient} 里没有 bean，
 *       端点返回 {@code configured=false} 和一句提示，不是 500、不是 401。
 *       和前端 "没有 Key 就是没有异常" 同构（frontend/server/llm/client.ts）。</li>
 *   <li><b>不写日志原文</b>：只记调用发生与否、模型名、耗时，
 *       不记 prompt 也不记回答 —— 医疗文本的最小泄露面。</li>
 *   <li><b>不暴露 Key</b>：返回体只有模型名和回答，没有任何配置内容；
 *       Key 只在 {@link AiVerificationConfig} 里从环境变量读。</li>
 * </ol>
 *
 * <p><b>鉴权：</b>不在 SecurityConfig 的白名单里，走默认
 * {@code anyRequest().authenticated()}。这是有意的 —— 一个会消耗真实 Token
 * 的端点不能匿名开放，否则任何人都能刷你的 Key。答辩演示时先登录即可。
 */
@Slf4j
@RestController
@RequestMapping("/api/ai")
public class AiVerificationController {

    /** ObjectProvider 而非直接注入：没 Key 时容器里根本没有 ChatClient bean。 */
    private final ObjectProvider<ChatClient> chatClient;

    private final String model;

    public AiVerificationController(ObjectProvider<ChatClient> chatClient,
                                    @Value("${zhidao.ai-verify.model:deepseek-chat}") String model) {
        this.chatClient = chatClient;
        this.model = model;
    }

    /**
     * 最小验证：调一次模型，回一句固定问题。
     *
     * <p>返回 {@code configured} 字段让答辩者一眼看出走的是真模型还是降级状态，
     * 不用翻日志。这是给"后端确实接入了 AI"这件事一个可当场演示的证据。
     */
    @GetMapping("/verify")
    public ApiResult<Map<String, Object>> verify() {
        ChatClient client = chatClient.getIfAvailable();
        if (client == null) {
            return ApiResult.ok(Map.of(
                    "configured", false,
                    "model", model,
                    "message", "未配置 ZHIDAO_LLM_API_KEY，AI 接入处于未启用状态（不影响其余功能）"));
        }

        long start = System.currentTimeMillis();
        try {
            String answer = client.prompt()
                    .user("请只回复两个字：正常")
                    .call()
                    .content();
            long cost = System.currentTimeMillis() - start;

            // 只记"调用了、用了什么模型、耗时多少"，不记 prompt 与回答内容
            log.info("AI 接入验证成功 model={} costMs={}", model, cost);
            return ApiResult.ok(Map.of(
                    "configured", true,
                    "model", model,
                    "answer", answer == null ? "" : answer,
                    "costMs", cost));
        } catch (RuntimeException e) {
            long cost = System.currentTimeMillis() - start;
            // 同样不记异常详情里的请求内容，只记类型，避免把原文带进日志
            log.warn("AI 接入验证调用失败 model={} costMs={} type={}",
                    model, cost, e.getClass().getSimpleName());
            return ApiResult.fail(50300, "模型调用失败：" + e.getClass().getSimpleName());
        }
    }
}
