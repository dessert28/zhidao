package com.zhidao.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 管理端新建用户。
 *
 * <p>长度校验放在 DTO 而不是 Service：这是"请求本身不合法"，
 * 应当在进入业务逻辑之前就被拦下；而"用户名已存在"是业务冲突，
 * 必须查库才知道，所以留给 Service 抛 40901。
 *
 * <p>不接收 {@code enabled}：新建账号一律启用。
 * "建一个禁用账号"没有真实场景，却给前端多一个可以填错的字段。
 */
public record AdminUserCreateRequest(

        @NotBlank(message = "用户名不能为空")
        @Size(min = 4, max = 64, message = "用户名长度需在 4-64 位之间")
        String username,

        @Size(max = 64, message = "展示名最长 64 位")
        String displayName,

        @NotBlank(message = "密码不能为空")
        @Size(min = 6, max = 64, message = "密码长度需在 6-64 位之间")
        String password,

        @NotBlank(message = "角色不能为空")
        String role
) {
}
