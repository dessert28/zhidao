package com.zhidao.common;

import lombok.Data;

import java.time.LocalDateTime;

/**
 * 统一响应体。
 *
 * <p>为什么不用裸对象直接返回：前端需要一致的方式判断"这次请求怎么样了"。
 * 让每个接口自己决定错误长什么样，前端就得为每个接口写一套判断。
 *
 * <p>{@code traceId} 不是装饰：出问题时用户截图给我们，
 * 靠它能在日志里定位到那一次请求。没有它，只能靠时间点猜。
 */
@Data
public class ApiResult<T> {

    private int code;
    private String message;
    private T data;
    private String traceId;
    private LocalDateTime timestamp;

    public static <T> ApiResult<T> ok(T data) {
        ApiResult<T> r = new ApiResult<>();
        r.code = 0;
        r.message = "ok";
        r.data = data;
        r.timestamp = LocalDateTime.now();
        return r;
    }

    public static <T> ApiResult<T> ok() {
        return ok(null);
    }

    public static <T> ApiResult<T> fail(int code, String message) {
        ApiResult<T> r = new ApiResult<>();
        r.code = code;
        r.message = message;
        r.timestamp = LocalDateTime.now();
        return r;
    }
}
