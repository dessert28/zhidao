package com.zhidao.common;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;

/**
 * 请求追踪：给每个进入后端的请求贴一个 id，写进 MDC 和响应头。
 *
 * <p>为什么需要它：日志里一条错误往往要和"用户说的是哪一次操作"对上。
 * 没有请求 id 时只能靠时间戳猜，而导诊场景里同一秒可能有十几个请求
 * （号源查询、目录、聊天历史并发拉）。id 是唯一能把它们分开的东西，
 * 也是前端报障时唯一能转给我们的线索 —— 用户截图里那句话，
 * 加上 id，就能在几十万行日志里精确捞出那一次调用。
 *
 * <p><b>为什么接受客户端传来的 {@code X-Request-Id}</b>：
 * 前端（含 Node BFF）可以在一次用户操作里生成一个 id 贯穿多层调用，
 * 后端复用它是"同一次操作"能被完整串起来的前提。
 * 但也因此它<b>不可信</b>，所以做两件事：
 * <ol>
 *   <li><b>长度与字符白名单校验</b>：超长或含控制字符的值直接丢弃改用 UUID。
 *       否则客户端能往日志里塞换行，伪造出整行假日志（日志注入）。</li>
 *   <li><b>只用于追踪，不用于鉴权与限流</b>：任何安全判断都不能读它。</li>
 * </ol>
 *
 * <p><b>隐私红线</b>：这个类只搬运请求头，<b>永不读取请求体</b>。
 * 病历原文、患者姓名、证件号都在请求体里，一旦在这里读出哪怕一次用于"打日志"，
 * 就再也拦不住了。追踪只需要一个 id，与内容无关。
 *
 * <p>顺序：{@link Ordered#HIGHEST_PRECEDENCE} 让它在最外层执行，
 * 这样连 Security 过滤器链里产生的日志（401 之前的部分）也带上 id。
 * {@code OncePerRequestFilter} 保证内部转发时不会重复吞掉上游传来的头。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {

    /** 请求/响应头名，前后端与 BFF 共用同一个约定 */
    public static final String HEADER = "X-Request-Id";

    /** MDC 的 key，必须和 application.yml 里 logging.pattern 的 %X{requestId} 一致 */
    public static final String MDC_KEY = "requestId";

    /** 上游给的 id 最长接受 64 个字符：UUID 36 位，留些余量给带前缀的实现 */
    private static final int MAX_LEN = 64;

    /**
     * 只接受可打印 ASCII 的 id。
     *
     * <p>不允许换行/回车/制表符不是洁癖：日志是逐行解析的，
     * 一个换行就能伪造出一条"来自系统"的假记录。
     */
    private static final java.util.regex.Pattern SAFE =
            java.util.regex.Pattern.compile("[A-Za-z0-9._:\\-]{1," + MAX_LEN + "}");

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        String incoming = req.getHeader(HEADER);
        String requestId = (incoming != null && SAFE.matcher(incoming).matches())
                ? incoming
                : UUID.randomUUID().toString();

        /*
         * 先放进 MDC，再交由下游 —— 顺序反了的话，
         * 下游（含异常处理器）打的第一行日志里就没有 id。
         *
         * putCloseable 而不是 put：它返回的对象在 close 时**只还原这一个 key**，
         * 不会像 MDC.clear() 那样把别人（例如框架自己）塞的上下文一起抹掉。
         * 但这里仍然用 put + finally remove：Servlet 线程池会复用线程，
         * finally 里的 remove 才能保证异常路径也清理干净 ——
         * 漏掉的表现是"下一个请求带着上一个请求的 id"，比没有 id 更误导人。
         */
        MDC.put(MDC_KEY, requestId);
        // 响应头也带回去：前端报障时能直接把它贴给我们，不用去翻日志
        res.setHeader(HEADER, requestId);
        try {
            chain.doFilter(req, res);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }
}
