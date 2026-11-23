package com.zhidao.agent;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhidao.agent.contract.ReviewPayload.ReviewScores;
import com.zhidao.agent.contract.TriagePayload;
import lombok.extern.slf4j.Slf4j;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.openai.api.ResponseFormat;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/**
 * 三个 Agent 的 LLM 实现 —— 对照 frontend/server/agents/llm-impl.ts。
 *
 * <p><b>为什么单独一个类而不是塞进各 Agent：</b>
 * Supervisor / Triage / Reviewer 的设计前提是"可注入依赖"
 * （{@code PlanFn} / {@code BiFunction} / judge），单测里能塞假实现。
 * 这里就是生产环境注入的那一份，规则层完全不动。
 *
 * <p><b>每个方法都必须满足：失败返回 null，绝不抛。</b>
 * 调用方收到 null 会走规则兜底 —— 这是 README 承诺过的"无 Key 也能完整演示"。
 *
 * <p><b>为什么强制 JSON 模式：</b>
 * 实测（2026-11-17，DeepSeek deepseek-flash / V4.1-Flash）走 AI SDK 默认的
 * auto / tool 模式会报 "Thinking mode does not support this tool_choice"（400），
 * 而 response_format=json_object 正常。V4 默认开思考，这是绕开它的唯一稳定路径。
 *
 * <p><b>为什么不重试：</b>业务层各有降级阶梯（坏输出 → 规则兜底）。在这里重试
 * 只会把一次 12 秒超时变成三次 36 秒，用户感知是"卡死"。
 */
@Slf4j
@Component
public class LlmAgentAdapter {

    /** 单次调用上限，对照 TS 的 CALL_TIMEOUT_MS = 12s */
    private static final long TIMEOUT_SECONDS = 12;

    /** 调用线程池：daemon，避免阻塞 JVM 退出 */
    private static final ExecutorService CALL_POOL = Executors.newFixedThreadPool(4, r -> {
        Thread t = new Thread(r, "llm-call");
        t.setDaemon(true);
        return t;
    });

    private static final List<String> SLOT_KEYS =
            List.of("部位", "时长", "性质", "诱因", "伴随");

    private final ChatClientFactory factory;
    private final LlmConfigService config;
    private final ObjectMapper objectMapper;

    public LlmAgentAdapter(ChatClientFactory factory, LlmConfigService config,
                           ObjectMapper objectMapper) {
        this.factory = factory;
        this.config = config;
        this.objectMapper = objectMapper;
    }

    /** 当前是否接了真模型（没 Key 时编排器不注入任何 LLM 依赖） */
    public boolean available() {
        return config.isConfigured();
    }

    /* ==================== 1. Supervisor 规划 ==================== */

    /**
     * 让模型给出路由计划 —— 对照 planViaLlm。
     *
     * <p>返回 Map 而不是 SupervisorPayload：{@code parsePlan} 还要再校验一遍语义
     * （agents 里混进 supervisor、decision 非法都会被打回，然后走规则路由）。
     * 校验留在 Agent 里，这里只负责"拿到一个对象"。
     */
    public Object plan(String text, boolean retryHint) {
        return askJson(LlmPrompts.SUPERVISOR_SYSTEM,
                LlmPrompts.supervisorPrompt(text, retryHint), 0.1);
    }

    /* ==================== 2. Triage 抽取 ==================== */

    /**
     * 让模型抽槽位 + 排科室 —— 对照 analyzeViaLlm。
     *
     * @param known 上一轮已采集的槽位（要一起传，否则模型会重复追问）
     */
    public TriageAgent.LlmAnalysis analyze(String text, Map<String, String> known, int round) {
        String knownLine = known == null ? "" : known.entrySet().stream()
                .filter(e -> e.getValue() != null && !e.getValue().isBlank())
                .map(e -> e.getKey() + "=" + e.getValue())
                .collect(Collectors.joining("，"));

        Map<String, Object> out = askJson(LlmPrompts.TRIAGE_SYSTEM,
                LlmPrompts.triagePrompt(text, knownLine, round), 0.1);
        if (out == null) return null;

        Map<String, String> slots = new LinkedHashMap<>();
        if (out.get("slots") instanceof Map<?, ?> rawSlots) {
            for (String key : SLOT_KEYS) {
                Object v = rawSlots.get(key);
                if (v instanceof String s && !s.isBlank()) slots.put(key, s.trim());
            }
        }

        List<TriagePayload.Department> departments = new ArrayList<>();
        if (out.get("departments") instanceof List<?> arr) {
            for (Object o : arr) {
                if (departments.size() >= 3) break;
                if (!(o instanceof Map<?, ?> d)) continue;
                Object name = d.get("name");
                Object reason = d.get("reason");
                if (!(name instanceof String n) || n.isBlank()) continue;
                if (!(reason instanceof String r) || r.isBlank()) continue;
                double conf = d.get("confidence") instanceof Number num ? num.doubleValue() : 0.6;
                conf = Math.max(0, Math.min(1, Math.round(conf * 100.0) / 100.0));
                departments.add(TriagePayload.Department.builder()
                        .name(n.trim())
                        .confidence(conf)
                        .reason(r.length() > 80 ? r.substring(0, 80) : r)
                        .build());
            }
        }

        // 空对象 / 空数组都算"模型没给出有效内容"，交给规则兜底（对照 TS 同名判断）
        if (slots.isEmpty() && departments.isEmpty()) return null;
        return new TriageAgent.LlmAnalysis(slots, departments);
    }

    /* ==================== 3. Reviewer 打分 ==================== */

    /**
     * LLM-as-judge —— 对照 judgeViaLlm。
     *
     * <p>分数只是参考：规则表的 safety 优先，规则判 0 时 judge 打满分也没用。
     */
    public ReviewScores judge(String answer, int evidenceCount) {
        Map<String, Object> out = askJson(LlmPrompts.JUDGE_SYSTEM,
                LlmPrompts.judgePrompt(answer, evidenceCount), 0);
        if (out == null) return null;
        return ReviewScores.builder()
                .safety(score(out.get("safety")))
                .accuracy(score(out.get("accuracy")))
                .completeness(score(out.get("completeness")))
                .groundedness(score(out.get("groundedness")))
                .build();
    }

    private static double score(Object raw) {
        double v = raw instanceof Number n ? n.doubleValue() : 0;
        v = Math.max(0, Math.min(1, v));
        return Math.round(v * 100.0) / 100.0;
    }

    /* ==================== 底层：JSON 调用 ==================== */

    /**
     * 要一个 JSON 对象回来，失败一律 null。
     *
     * <p>用线程池 + get(timeout) 做超时，而不是指望 HTTP 客户端超时：
     * RestClient 默认不设读超时，模型挂住会把一条 SSE 拖到 120 秒的
     * emitter 上限。这里到点就放弃，让业务层立刻降级。
     */
    private Map<String, Object> askJson(String system, String prompt, double temperature) {
        Optional<ChatClient> client = factory.create();
        if (client.isEmpty()) return null;

        long start = System.currentTimeMillis();
        Future<String> future = null;
        try {
            future = CALL_POOL.submit(() -> client.get().prompt()
                    .system(system)
                    .user(prompt)
                    .options(OpenAiChatOptions.builder()
                            .model(config.model())
                            .temperature(temperature)
                            .responseFormat(new ResponseFormat(ResponseFormat.Type.JSON_OBJECT, (String) null))
                            .build())
                    .call()
                    .content());

            String raw = future.get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            Map<String, Object> obj = parseObject(raw);
            if (obj == null) {
                log.warn("[llm] 输出不是合法 JSON 对象，降级到规则 costMs={}",
                        System.currentTimeMillis() - start);
            }
            return obj;
        } catch (java.util.concurrent.TimeoutException e) {
            if (future != null) future.cancel(true);
            log.warn("[llm] 调用超时（{}s），降级到规则", TIMEOUT_SECONDS);
            return null;
        } catch (Exception e) {
            // 只记类型，不记 prompt（里面有患者症状）
            log.warn("[llm] 调用失败，降级到规则 type={} costMs={}",
                    e.getClass().getSimpleName(), System.currentTimeMillis() - start);
            return null;
        }
    }

    /** 容忍 ```json 围栏与前后多余文字 —— 模型不总是老实只输出 JSON */
    private Map<String, Object> parseObject(String raw) {
        if (raw == null || raw.isBlank()) return null;
        String t = raw.trim();
        int begin = t.indexOf('{');
        int end = t.lastIndexOf('}');
        if (begin < 0 || end <= begin) return null;
        try {
            return objectMapper.readValue(t.substring(begin, end + 1),
                    new TypeReference<Map<String, Object>>() {});
        } catch (Exception e) {
            return null;
        }
    }
}
