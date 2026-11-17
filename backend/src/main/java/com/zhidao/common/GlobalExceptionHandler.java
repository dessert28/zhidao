package com.zhidao.common;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;

import java.util.UUID;
import java.util.stream.Collectors;

/**
 * 全局异常处理。
 *
 * <p>三条原则：
 * <ol>
 *   <li><b>业务异常原样返回消息</b> —— 它本来就是写给用户看的</li>
 *   <li><b>校验失败列全所有字段错误</b> —— 告诉用户"哪里不对"，
 *       而不是笼统的"参数错误"</li>
 *   <li><b>系统异常只返回 traceId</b> —— 后端堆栈信息对用户没有意义，
 *       泄露出去反而暴露内部结构。日志里有完整堆栈，靠 traceId 关联</li>
 * </ol>
 *
 * <p><b>关于 HTTP 状态码</b>：必须返回真正的 4xx/5xx，不能一律 200。
 * 曾经这里用 {@code @ResponseStatus(HttpStatus.BAD_REQUEST)} 给所有业务异常
 * 都打了 400，结果是"密码错了"和"服务器崩了"在客户端看起来一样，
 * 前端无法区分"该改输入"还是"该重试"。现在按 code 段位映射：
 * <pre>
 *   40000-40099  参数/业务校验   -> 400
 *   40100-40199  未认证         -> 401
 *   40300-40399  无权限         -> 403
 *   40400-40499  资源不存在     -> 404
 *   40900-40999  状态冲突       -> 409
 *   其他          -> 400（业务异常默认仍是客户端问题）
 * </pre>
 *
 * <h3>⚠️ 隐私红线（硬约束，改动本类前必读）</h3>
 *
 * <p><b>病历原文、患者姓名、证件号一律不进服务端日志。</b>
 * 这不是"尽量"，是不可协商的：日志会被采集、落盘、转存到日志平台，
 * 一旦进去就脱离了本系统所有的脱敏与权限控制，等于把受保护的健康信息
 * （PHI）复制到一堆没人管的地方。本类的做法是：
 * <ul>
 *   <li><b>永不读取请求体</b>。这里能拿到的只有 {@link HttpServletRequest}，
 *       但代码只取 {@code getMethod()} 与 {@code getRequestURI()} ——
 *       路径和动词与内容无关，足以定位问题。
 *       不要为了"记全一点"去调 {@code getReader()} / {@code getInputStream()}：
 *       请求体读过一次就被消费掉，还可能把病历原文写进日志。</li>
 *   <li><b>系统异常只打「异常类型 + message」再加堆栈，不打参数值</b>。
 *       堆栈本身是调用链（类名/行号），不含数据；而 message 里偶尔会带
 *       SQL 参数或字段值（例如 {@code NumberFormatException}），
 *       所以 message 也要截断，防止一整段 Base64 病历糊满日志。</li>
 *   <li><b>校验失败只在日志里记字段名，不记字段值</b>。
 *       校验失败最常见于"证件号格式不对""姓名超长"这类输入，
 *       把值打出来恰好就是泄露那三个敏感字段。</li>
 * </ul>
 *
 * <p>追踪用 {@link com.zhidao.common.RequestIdFilter} 写入 MDC 的 requestId，
 * 日志行里自带，所以这里的 traceId 只用于响应体（用户能看见的那一份）。
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    /**
     * 异常 message 在日志里的长度上限。
     *
     * <p>为什么要截断：message 不受我们控制。上游 Jackson 的
     * {@code UnrecognizedPropertyException} 会把整段无法识别的 JSON 贴进 message，
     * 而那段 JSON 很可能就是一份完整的病历。截断是兜底闸门 ——
     * 只保留开头定位问题所需的部分，不让整块内容冲进日志文件。
     */
    private static final int MAX_MESSAGE_LEN = 200;

    @ExceptionHandler(BizException.class)
    public ResponseEntity<ApiResult<Void>> handleBiz(BizException e, HttpServletRequest req) {
        // 业务异常的消息是写给用户看的，不含病历内容（见 BizException 的类注释）
        log.warn("业务异常 {} {} : {}", req.getMethod(), req.getRequestURI(), e.getMessage());
        ApiResult<Void> body = ApiResult.fail(e.getCode(), e.getMessage());
        return ResponseEntity.status(statusOf(e.getCode())).body(body);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResult<Void>> handleValidation(MethodArgumentNotValidException e) {
        String detail = e.getBindingResult().getFieldErrors().stream()
                .map(this::describeFieldError)
                .collect(Collectors.joining("；"));

        /*
         * 只在服务端记**字段名**，不记用户填的值。
         * 校验失败最常发生在姓名、证件号这类字段上，
         * 把值打进日志等于把红线字段抄了一份出来。
         * detail 本身（字段名 + 提示语）是安全的，可以进日志。
         */
        log.debug("参数校验失败 字段数={} {}", e.getBindingResult().getFieldErrorCount(), detail);

        return ResponseEntity.badRequest()
                .body(ApiResult.fail(40001, detail.isEmpty() ? "请求参数不合法" : detail));
    }

    /**
     * 兜底：未预期异常。
     *
     * <p><b>这里是最容易破坏隐私红线的地方</b>，所以显式说明它打了什么、没打什么：
     * 打了 —— 异常类型、截断后的 message、堆栈、请求方法与路径；
     * <b>没打</b> —— 请求体、任何请求参数值、任何患者数据。
     * 堆栈走的是日志后端的异常链路（{@code %ex}），
     * 与 message 拼接的是两个独立的占位符，不会把异常对象本身序列化进正文。
     */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResult<Void>> handleUnknown(Exception e, HttpServletRequest req) {
        String traceId = UUID.randomUUID().toString().substring(0, 8);

        /*
         * 单独一行打类型 + 截断后的 message，再单独把堆栈交给日志框架。
         * 不写 log.error("... {}", e) —— 那样 e 会被 toString 进正文，
         * 部分异常（如 SQLException 的包装）的 toString 带参数值。
         */
        log.error("未预期异常 traceId={} type={} message={} {} {}",
                traceId,
                e.getClass().getName(),
                truncate(e.getMessage()),
                req.getMethod(),
                req.getRequestURI(),
                e);

        ApiResult<Void> r = ApiResult.fail(50000, "服务暂时不可用，请稍后重试（错误编号 " + traceId + "）");
        r.setTraceId(traceId);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(r);
    }

    /**
     * 截断异常 message。
     *
     * <p>见 {@link #MAX_MESSAGE_LEN} 的说明：message 可能整段带上请求内容。
     * 顺带把换行压成空格，避免一条消息拆成多行、破坏日志的逐行解析。
     */
    private String truncate(String msg) {
        if (msg == null) return "-";
        String oneLine = msg.replaceAll("[\\r\\n\\t]+", " ");
        return oneLine.length() <= MAX_MESSAGE_LEN
                ? oneLine
                : oneLine.substring(0, MAX_MESSAGE_LEN) + "…(已截断)";
    }

    private HttpStatus statusOf(int code) {
        if (code >= 40100 && code < 40200) return HttpStatus.UNAUTHORIZED;
        if (code >= 40300 && code < 40400) return HttpStatus.FORBIDDEN;
        if (code >= 40400 && code < 40500) return HttpStatus.NOT_FOUND;
        if (code >= 40900 && code < 41000) return HttpStatus.CONFLICT;
        return HttpStatus.BAD_REQUEST;
    }

    /**
     * 字段错误的展示文案。
     *
     * <p>只拼"字段名 + 校验提示"，<b>刻意不取 {@code fe.getRejectedValue()}</b>：
     * 那个值就是用户输入本身（姓名、证件号）。前端需要的是"哪里错了"，
     * 不是"你填了什么"。
     */
    private String describeFieldError(FieldError fe) {
        return fe.getField() + " " + fe.getDefaultMessage();
    }
}
