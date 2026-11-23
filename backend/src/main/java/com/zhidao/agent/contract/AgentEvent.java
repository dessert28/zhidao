package com.zhidao.agent.contract;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.Map;

/**
 * SSE 事件 —— 对照 frontend/src/types/events.ts 的 14 种 AgentEvent。
 *
 * <p>TS 版是判别式联合（discriminated union），Java 没有原生对应物，
 * 这里用「type 判别字段 + 全部可选载荷」的单一类表达。Jackson 序列化时
 * 通过 {@code @JsonInclude(NON_NULL)} 去掉未使用的字段，使得发出的 JSON
 * 与 TS 版每个事件对象严格一致 —— 前端按 type 渲染，多余字段不存在。
 *
 * <p>这是迁移的关键契约点：事件 shape 必须与 TS 版逐字段对齐，
 * 否则前端 14 种渲染器会取不到值。
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@JsonInclude(JsonInclude.Include.NON_NULL)
public class AgentEvent {
    /** 判别式：plan/token/tool_call/tool_result/clarify/department_card/... */
    private String type;

    /* plan */
    private String decision;
    private String reason;
    private List<String> agents;

    /* token / caveat / speech */
    private String text;
    private String lang;
    private Integer seq;

    /* tool_call / tool_result */
    private String name;
    private Map<String, Object> args;
    private Object result;
    private Boolean ok;

    /* clarify */
    private List<String> missing;
    private String question;

    /* department_card / timeline_card */
    private List<Map<String, Object>> departments;
    private List<Map<String, Object>> tasks;

    /* booking_preview_card */
    private Map<String, Object> preorder;

    /* review_trace */
    private Map<String, Object> scores;
    private String action;

    /* retry */
    private String from;
    private String to;
    private Integer round;

    /* emergency */
    private Map<String, Object> redFlag;

    /* done */
    private String turnId;
    private Long elapsedMs;
    private Boolean degraded;
    private Map<String, Object> session;

    /** 生成式 UI 增强字段（sse.ts 的 UiPayload） */
    private String html;
    private Map<String, Object> props;

    /* ---- 静态工厂：让事件构造点清晰、不易写错字段 ---- */
    public static AgentEvent plan(String decision, String reason, List<String> agents) {
        return AgentEvent.builder().type("plan").decision(decision).reason(reason).agents(agents).build();
    }

    public static AgentEvent token(String text) {
        return AgentEvent.builder().type("token").text(text).build();
    }

    public static AgentEvent retry(String reason, String from, String to, int round) {
        return AgentEvent.builder().type("retry").reason(reason).from(from).to(to).round(round).build();
    }

    public static AgentEvent caveat(String text) {
        return AgentEvent.builder().type("caveat").text(text).build();
    }

    public static AgentEvent toolResult(String name, boolean ok, Object result) {
        return AgentEvent.builder().type("tool_result").name(name).ok(ok).result(result).build();
    }

    public static AgentEvent done(String turnId, long elapsedMs, boolean degraded, Map<String, Object> session) {
        return AgentEvent.builder().type("done").turnId(turnId).elapsedMs(elapsedMs)
                .degraded(degraded).session(session).build();
    }
}
