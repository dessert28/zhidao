package com.zhidao.dto;

/**
 * 登录响应。
 *
 * <p>{@code expiresIn} 给的是<b>秒</b>，不是时间戳：
 * 客户端时钟不可信，用"还剩多久"让前端自己换算成倒计时，
 * 差个几秒不影响，差个几小时就会莫名其妙 401。
 */
public record LoginResponse(
        String token,
        long userId,
        String username,
        String role,
        long expiresIn
) {
}
