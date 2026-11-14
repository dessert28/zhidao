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
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BizException.class)
    public ResponseEntity<ApiResult<Void>> handleBiz(BizException e, HttpServletRequest req) {
        log.warn("业务异常 {} {} : {}", req.getMethod(), req.getRequestURI(), e.getMessage());
        ApiResult<Void> body = ApiResult.fail(e.getCode(), e.getMessage());
        return ResponseEntity.status(statusOf(e.getCode())).body(body);
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResult<Void>> handleValidation(MethodArgumentNotValidException e) {
        String detail = e.getBindingResult().getFieldErrors().stream()
                .map(this::describeFieldError)
                .collect(Collectors.joining("；"));
        return ResponseEntity.badRequest()
                .body(ApiResult.fail(40001, detail.isEmpty() ? "请求参数不合法" : detail));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResult<Void>> handleUnknown(Exception e, HttpServletRequest req) {
        String traceId = UUID.randomUUID().toString().substring(0, 8);
        log.error("未预期异常 traceId={} {} {}", traceId, req.getMethod(), req.getRequestURI(), e);
        ApiResult<Void> r = ApiResult.fail(50000, "服务暂时不可用，请稍后重试（错误编号 " + traceId + "）");
        r.setTraceId(traceId);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(r);
    }

    private HttpStatus statusOf(int code) {
        if (code >= 40100 && code < 40200) return HttpStatus.UNAUTHORIZED;
        if (code >= 40300 && code < 40400) return HttpStatus.FORBIDDEN;
        if (code >= 40400 && code < 40500) return HttpStatus.NOT_FOUND;
        if (code >= 40900 && code < 41000) return HttpStatus.CONFLICT;
        return HttpStatus.BAD_REQUEST;
    }

    private String describeFieldError(FieldError fe) {
        return fe.getField() + " " + fe.getDefaultMessage();
    }
}
