package com.zhidao.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * 登录请求。
 *
 * <p>只有用户名和密码两个字段 —— 没有手机号，<b>不是简化，是产品定义</b>。
 * 见 docs/09 三条硬约束：账号体系不收手机号与身份证。
 */
public record LoginRequest(
        @NotBlank(message = "用户名不能为空") String username,
        @NotBlank(message = "密码不能为空") String password
) {
}
