package com.zhidao.vo;

import java.time.LocalDateTime;

/**
 * 管理端用户列表项。
 *
 * <p><b>为什么不直接返回 {@code SysUser}</b>：实体会带出
 * {@code passwordHash} 与 {@code recoveryHash}。即使前端"不显示"，
 * 它们也已经在响应体里、在浏览器网络面板里、在任何一层代理日志里。
 * 一旦泄露，攻击者可以离线爆破密码，而我们对"密码已泄露"无能为力。
 *
 * <p>用 record 做投影是编译期保证：新增实体字段不会自动出现在接口里，
 * 必须显式加到这个 record 上 —— 那一步会有人问"这个字段能公开吗"。
 */
public record AdminUserView(
        Long id,
        String username,
        String displayName,
        String role,
        Boolean enabled,
        LocalDateTime createdAt
) {
}
