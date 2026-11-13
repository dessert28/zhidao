package com.zhidao.common;

import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestControllerAdvice;

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
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BizException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ApiResult<Void> handleBiz(BizException e, HttpServletRequest req) {
        log.warn("业务异常 {} {} : {}", req.getMethod(), req.getRequestURI(), e.getMessage());
        return ApiResult.fail(e.getCode(), e.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ApiResult<Void> handleValidation(MethodArgumentNotValidException e) {
        String detail = e.getBindingResult().getFieldErrors().stream()
                .map(this::describeFieldError)
                .collect(Collectors.joining("；"));
        return ApiResult.fail(40001, detail.isEmpty() ? "请求参数不合法" : detail);
    }

    @ExceptionHandler(Exception.class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    public ApiResult<Void> handleUnknown(Exception e, HttpServletRequest req) {
        String traceId = UUID.randomUUID().toString().substring(0, 8);
        log.error("未预期异常 traceId={} {} {}", traceId, req.getMethod(), req.getRequestURI(), e);
        ApiResult<Void> r = ApiResult.fail(50000, "服务暂时不可用，请稍后重试（错误编号 " + traceId + "）");
        r.setTraceId(traceId);
        return r;
    }

    private String describeFieldError(FieldError fe) {
        return fe.getField() + " " + fe.getDefaultMessage();
    }
}
