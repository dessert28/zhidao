package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.entity.ChatMessage;
import com.zhidao.mapper.ChatMessageMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 问诊对话的读写。
 *
 * <p>这个类只解决一件事：<b>让对话活过页面刷新</b>。
 * 在那之前，turns 是 React state、槽位与轮次放在 useRef 里，
 * 一次 F5 就把患者说过的「咳嗽三天、有黄痰」抹干净，
 * AI 随即从头再问一遍 —— 患者只会得出"它没在听"的结论。
 *
 * <p><b>所有方法都以 userId 为第一参数，这不是冗余。</b>
 * sessionId 由前端生成（crypto.randomUUID），前端能改也能猜；
 * 只用它定位会话，等于把"读谁的对话"交给了调用方。
 * 服务层的签名强制调用方先亮出 JWT 里的身份（{@code CurrentUser.id()}），
 * 让"忘了带 userId"变成编译不过，而不是上线后被越权读到别人的问诊记录。
 *
 * <p>写入失败**不影响本轮回答**：留痕是锦上添花，
 * 患者要看的是医生的建议，不能因为存历史这一步抛异常就让整轮对话报错。
 * 因此这里吞掉写入侧的异常，只记日志 —— 这是本类唯一一处"故意不抛"的地方。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ChatService {

    /**
     * {@link #history} 的条数上限。
     *
     * <p>为什么要封顶：一次会话可能有几百条，全量回传既拖慢首屏，
     * 也让前端要处理"很长的列表"这个它并不需要的场景。
     * 200 条足够盖住一次完整分诊（追问上限是 3 轮，加上患者自述与补充说明）。
     */
    public static final int MAX_HISTORY_LIMIT = 200;

    private final ChatMessageMapper chatMapper;

    /**
     * 追加一条消息。
     *
     * <p>{@code turnId} 允许为空：同一次提问的 user 与 assistant 两条消息
     * 共用一个 turnId，回放时才能把回答对回到它的问题上；
     * 不属于任何一轮的系统提示语（比如"已进入新的对话"）就没有。
     *
     * <p>不接事务注解：单条 insert 自带原子性，
     * 包一层事务只会多一次提交开销，对失败语义没有任何改变。
     *
     * @param userId    当前患者，来自 JWT
     * @param sessionId 会话标识
     * @param turnId    本轮问答的配对键，可为 null
     * @param role      {@link ChatMessage#ROLE_USER} 或 {@link ChatMessage#ROLE_ASSISTANT}
     * @param content   脱敏后的文本
     */
    public void append(long userId, String sessionId, String turnId, String role, String content) {
        // 空内容不落库：没有任何回放价值，反而会在历史里留下一段空白气泡
        if (content == null || content.isBlank()) {
            return;
        }
        if (!ChatMessage.ROLE_USER.equals(role) && !ChatMessage.ROLE_ASSISTANT.equals(role)) {
            // 角色是回放时的分支依据，写进一个没人认识的取值等于给前端埋一个渲染空洞
            log.warn("丢弃未知角色的对话消息 role={} userId={}", role, userId);
            return;
        }

        ChatMessage msg = new ChatMessage();
        msg.setUserId(userId);
        msg.setSessionId(sessionId);
        msg.setTurnId(turnId);
        msg.setRole(role);
        msg.setContent(content);

        try {
            chatMapper.insert(msg);
        } catch (RuntimeException e) {
            /*
             * 留痕失败不能连累正在进行的对话。
             * 这里不对称地"只读侧抛、写侧吞"，是刻意的：
             * 读失败用户立刻就会看到（历史为空 = 功能坏了），
             * 写失败用户不会察觉，而我们能从日志里补。
             */
            log.error("对话消息写入失败 userId={} sessionId={} turnId={}",
                    userId, sessionId, turnId, e);
        }
    }

    /**
     * 取某会话最近 {@code limit} 条消息，返回时是<b>时间正序</b>。
     *
     * <p>为什么要"倒着取、正着给"：取最近 N 条必须用 created_at DESC
     * 才能在数据库层截断（正序取前 N 条会拿到最老的 N 条）；
     * 而前端渲染对话气泡必须是正序。两段方向不同，所以这里要反转一次。
     *
     * <p>created_at 只精确到秒，同一秒内的一问一答顺序不定；
     * 用 id 作为第二排序键兜底 —— 自增 id 天然反映插入先后，
     * 没有它会出现"回答排在问题上面"这种一眼可见的错乱。
     *
     * @param limit 条数上限，非正数按 1 处理，超过 {@link #MAX_HISTORY_LIMIT} 按上限截断
     */
    public List<ChatMessage> history(long userId, String sessionId, int limit) {
        if (sessionId == null || sessionId.isBlank()) {
            return List.of();
        }
        int effective = Math.min(Math.max(limit, 1), MAX_HISTORY_LIMIT);

        List<ChatMessage> desc = chatMapper.selectList(new LambdaQueryWrapper<ChatMessage>()
                .eq(ChatMessage::getUserId, userId)
                .eq(ChatMessage::getSessionId, sessionId)
                .orderByDesc(ChatMessage::getCreatedAt)
                .orderByDesc(ChatMessage::getId)
                .last("LIMIT " + effective));

        // 用副本反转，不原地改 selectList 的返回：列表实现的不可变性不该被假定
        List<ChatMessage> asc = new ArrayList<>(desc);
        Collections.reverse(asc);
        return asc;
    }

    /**
     * 该用户最近一次有消息的 sessionId；一条都没有时返回 {@code null}。
     *
     * <p>刷新页面后前端要靠它回到"上次说到哪儿"，否则只能新建一个空会话——
     * 那和没有持久化没有区别。
     *
     * <p>返回 null 而不是抛异常或生成新 id：
     * "没有历史"是首次使用的正常状态，不是错误。
     * 是否新建会话由前端决定（它才知道用户的意图）。
     */
    public String latestSessionId(long userId) {
        ChatMessage latest = chatMapper.selectOne(new LambdaQueryWrapper<ChatMessage>()
                .eq(ChatMessage::getUserId, userId)
                .orderByDesc(ChatMessage::getCreatedAt)
                .orderByDesc(ChatMessage::getId)
                .last("LIMIT 1"));
        return latest == null ? null : latest.getSessionId();
    }

    /**
     * 清空某会话的全部消息（逻辑删除）。
     *
     * <p>逻辑删除而不是物理删除：问诊内容属于可能被追溯的材料，
     * 用户要求的"清空"是"不要再显示给我看"，不等于"允许你抹掉记录"。
     * 两者混为一谈，出纠纷时就会变成"系统里查不到了"。
     *
     * <p>条件里必须同时带 userId：只按 sessionId 删除，
     * 等于任何人猜到 id 就能清掉别人的对话。
     *
     * @return 受影响的行数，便于上层回显"清掉了多少条"
     */
    @Transactional
    public int clearSession(long userId, String sessionId) {
        if (sessionId == null || sessionId.isBlank()) {
            return 0;
        }
        int removed = chatMapper.delete(new LambdaQueryWrapper<ChatMessage>()
                .eq(ChatMessage::getUserId, userId)
                .eq(ChatMessage::getSessionId, sessionId));

        log.info("清空问诊会话 userId={} sessionId={} 条数={}", userId, sessionId, removed);
        return removed;
    }
}
