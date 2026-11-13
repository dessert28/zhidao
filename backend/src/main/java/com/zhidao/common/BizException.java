package com.zhidao.common;

/**
 * 业务异常。
 *
 * <p>与系统异常的区别在于<b>谁该看到这条消息</b>：
 * 业务异常的消息是写给用户看的（"该预约已取消，不能再次确认"），
 * 系统异常的消息是写给开发者看的（NPE 的堆栈）。
 * 所以后者绝不能被透传到响应体里。
 */
public class BizException extends RuntimeException {

    private final int code;

    public BizException(String message) {
        this(40000, message);
    }

    public BizException(int code, String message) {
        super(message);
        this.code = code;
    }

    public int getCode() {
        return code;
    }
}
