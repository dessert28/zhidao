package com.zhidao.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhidao.agent.ChatOrchestrator;
import com.zhidao.agent.ChatRequest;
import com.zhidao.agent.contract.AgentEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * AI 导诊对话端点 —— 替代 Node BFF 的 POST /api/chat。
 *
 * <p>事件帧格式与 TypeScript 版 sse.ts 完全一致：
 * <pre>
 *   event: &lt;type&gt;\n
 *   data: &lt;json&gt;\n\n
 * </pre>
 * 前端的 14 种事件渲染器无需改动，只改请求指向。
 *
 * <p>输入校验对齐 chat.ts：空白文本 400、超 2000 字 413。
 */
@Slf4j
@RestController
@RequestMapping("/api/chat")
public class ChatController {

    private static final int MAX_TEXT_LENGTH = 2000;
    private static final long SSE_TIMEOUT_MS = 120_000L;

    private final ChatOrchestrator orchestrator;
    private final ObjectMapper objectMapper;
    private final ExecutorService executor = Executors.newCachedThreadPool();

    public ChatController(ChatOrchestrator orchestrator, ObjectMapper objectMapper) {
        this.orchestrator = orchestrator;
        this.objectMapper = objectMapper;
    }

    /** 输入校验结果 */
    private record Validation(String error, String message, int status) {}

    /*
     * 不声明 produces = text/event-stream：校验失败要返回 JSON（400/413），
     * 一旦声明了 produces，Spring 会拿 text/event-stream 去序列化错误 JSON，
     * 找不到转换器就变成 500（实测踩过）。SSE 的 Content-Type 在成功路径上
     * 由 SseEmitter 自己设置。
     */
    @PostMapping
    public Object chat(@RequestBody(required = false) ChatRequest req) {
        Validation v = validate(req);
        if (v != null) {
            return ResponseEntity.status(v.status())
                    .body(Map.of("error", v.error(), "message", v.message()));
        }

        SseEmitter emitter = new SseEmitter(SSE_TIMEOUT_MS);
        executor.submit(() -> {
            try {
                ChatOrchestrator.TurnResult result = orchestrator.run(req);
                for (AgentEvent event : result.events()) {
                    String json = objectMapper.writeValueAsString(event);
                    emitter.send(SseEmitter.event().name(event.getType()).data(json));
                }
                emitter.complete();
            } catch (IOException e) {
                // 客户端断开是正常情况（用户关页面），不算服务端错误
                log.debug("[chat] SSE 连接已关闭: {}", e.getMessage());
                emitter.completeWithError(e);
            } catch (Exception e) {
                log.error("[chat] 编排失败", e);
                try {
                    AgentEvent caveat = AgentEvent.caveat("本轮回答未能完成，请稍后重试或转人工咨询。");
                    emitter.send(SseEmitter.event().name("caveat")
                            .data(objectMapper.writeValueAsString(caveat)));
                    emitter.complete();
                } catch (IOException ignored) {
                    emitter.completeWithError(e);
                }
            }
        });
        return emitter;
    }

    /**
     * 事件 → SSE 帧文本 —— 对照 sse.ts 的 frame()：{@code event: <type>\ndata: <json>\n\n}。
     * 抽成独立方法便于单测（MockMvc 测异步 SseEmitter 的时序不可靠）。
     */
    public String toSseFrame(AgentEvent event) throws IOException {
        return "event: " + event.getType() + "\ndata: "
                + objectMapper.writeValueAsString(event) + "\n\n";
    }

    /** 健康检查：前端探测端点是否可用 */
    @GetMapping("/health")
    public Map<String, Object> health() {
        return Map.of("ok", true, "engine", "spring-ai-java");
    }

    private Validation validate(ChatRequest req) {
        if (req == null || req.getText() == null || req.getText().trim().isEmpty()) {
            return new Validation("text_required", "请输入内容", 400);
        }
        if (req.getText().length() > MAX_TEXT_LENGTH) {
            return new Validation("text_too_long",
                    "输入太长（" + req.getText().length() + " 字，上限 " + MAX_TEXT_LENGTH
                            + " 字）。请简短描述症状，或把完整病历上传到「我的病历」。", 413);
        }
        return null;
    }
}
