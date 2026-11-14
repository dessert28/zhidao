package com.zhidao.security;

import com.zhidao.common.BizException;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

/**
 * 取当前登录用户 id。
 *
 * <p><b>为什么必须有这个方法</b>：Controller 绝不能从请求参数里读 {@code userId}。
 * 那样任何登录用户改一个数字就能看别人的病历 —— 这是最典型也最容易被
 * 漏掉的越权（IDOR）。用户身份只能来自经过签名校验的令牌。
 */
public final class CurrentUser {

    private CurrentUser() {
    }

    /** 当前用户 id；未认证时抛 401 语义的业务异常 */
    public static long id() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !auth.isAuthenticated() || !(auth.getPrincipal() instanceof Long id)) {
            throw new BizException(40100, "登录已失效，请重新登录");
        }
        return id;
    }
}
