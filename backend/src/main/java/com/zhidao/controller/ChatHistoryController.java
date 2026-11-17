package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.entity.ChatMessage;
import com.zhidao.security.CurrentUser;
import com.zhidao.service.ChatService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * 问诊对话历史。
 *
 * <p><b>这个 Controller 存在的唯一目的：刷新页面不丢上下文。</b>
 * 之前对话只活在浏览器里，F5 之后 AI 会重新问「咳嗽多久了」，
 * 患者刚回答过的话像是没被听见。有了这两个接口，
 * 前端启动时就能把上次说到哪儿原样接上。
 *
 * <p><b>刻意不放进 SecurityConfig 的 permitAll。</b>
 * 这里返回的是患者亲口描述的症状，是全网最不该公开的那类数据。
 * 保持默认的 {@code anyRequest().authenticated()}，
 * 让"没带 JWT 就 401"由框架兜住，而不是靠每个方法自觉。
 *
 * <p>userId 一律来自 {@link CurrentUser#id()}（JWT 里的身份），
 * <b>没有任何接口接受 userId 参数</b>：接受它，
 * 就等于让登录用户改一个数字读别人的问诊 —— 见 CurrentUser 的注释。
 */
@RestController
@RequestMapping("/api/chat-history")
@RequiredArgsConstructor
public class ChatHistoryController {

    private final ChatService chatService;

    /**
     * 写入一条消息。
     *
     * <p><b>为什么写入要走接口而不是直接让 BFF 连库</b>：
     * 后端是唯一持有业务规则与身份体系的地方。BFF 直连数据库
     * 就意味着两处都能写、两处都要懂表结构，迟早不一致。
     *
     * <p>调用方是 BFF 的 `/api/chat`：一轮对话结束后，
     * 它把 user 和 assistant 两条消息写入。之所以由它写而不是前端写：
     * assistant 的正文是它一路 emit 出去拼起来的，
     * 前端看到的可能还被 Reviewer 追加过"修订"——
     * 由产生方记录，才只有一份真相。
     *
     * <p>{@code sessionId} 与 {@code turnId} 都由调用方给：
     * 它们属于"这一轮对话"的标识，后端不该重新生成一个。
     *
     * @return 写入后的消息 id
     */
    @PostMapping
    public ApiResult<java.util.Map<String, Object>> append(@RequestBody AppendRequest req) {
        /*
         * 内容为空的直接拒绝，而不是写一条空消息。
         * 空记录在界面上是一个空气泡，比没有记录更让人困惑。
         */
        if (req.content() == null || req.content().isBlank()) {
            return ApiResult.fail(40000, "消息内容不能为空");
        }
        if (!"user".equals(req.role()) && !"assistant".equals(req.role())) {
            return ApiResult.fail(40000, "role 只能是 user 或 assistant");
        }
        if (req.sessionId() == null || req.sessionId().isBlank()) {
            return ApiResult.fail(40000, "sessionId 不能为空");
        }

        chatService.append(CurrentUser.id(), req.sessionId(), req.turnId(), req.role(), req.content());
        return ApiResult.ok(java.util.Map.of("saved", true));
    }

    /**
     * 写入请求体。
     *
     * <p>字段名与前端 `useEventStream` 的语义一一对应，
     * 不做别名兼容 —— 多一套兼容就多一处"到底用哪个"的困惑。
     */
    public record AppendRequest(
            String sessionId,
            String turnId,
            String role,
            String content) {
    }

    /**
     * 取会话历史（时间正序）。
     *
     * <p>{@code sessionId} 不传时用 {@link ChatService#latestSessionId} 兜底：
     * 刷新页面那一刻前端手里还没有任何 session，它得先问"上次聊到哪儿了"。
     * 让这件事由服务端决定（而不是前端存 localStorage），
     * 是为了换设备、换浏览器登录时也能接上 —— 那正是"丢上下文"的另一种形态。
     *
     * @param sessionId 可选；为空则取该用户最近一次有消息的会话
     * @param limit     可选，返回条数上限；缺省 50（一次分诊的实际长度约十几条）
     * @return 历史消息；首次使用（既没传 sessionId 也没有任何历史）返回空列表而非 404 ——
     *         "还没有对话"是正常状态，不该让前端走错误分支
     */
    @GetMapping
    public ApiResult<List<ChatMessage>> history(
            @RequestParam(required = false) String sessionId,
            @RequestParam(defaultValue = "50") int limit) {

        long userId = CurrentUser.id();
        String effectiveSessionId = (sessionId == null || sessionId.isBlank())
                ? chatService.latestSessionId(userId)
                : sessionId;

        // latestSessionId 为 null 说明这个用户从未说过话，直接给空列表
        if (effectiveSessionId == null) {
            return ApiResult.ok(List.of());
        }
        return ApiResult.ok(chatService.history(userId, effectiveSessionId, limit));
    }

    /**
     * 清空一个会话。
     *
     * <p>为什么用 DELETE 而不是「标记归档」这种软接口：
     * 用户点「清空对话」期待的就是它消失。
     * 底层仍是逻辑删除（见 {@link ChatService#clearSession}），
     * 但对外语义该是什么就是什么 —— 把存储策略泄露成接口语义，
     * 前端就要为"它还在但你别看"写一套别扭的逻辑。
     *
     * @param sessionId 要清空的会话
     * @return 被清掉的消息条数
     */
    @DeleteMapping("/{sessionId}")
    public ApiResult<java.util.Map<String, Object>> clear(@PathVariable String sessionId) {
        int removed = chatService.clearSession(CurrentUser.id(), sessionId);
        return ApiResult.ok(java.util.Map.of("removed", removed));
    }
}
