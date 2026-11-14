package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.common.BizException;
import com.zhidao.dto.LoginRequest;
import com.zhidao.dto.LoginResponse;
import com.zhidao.entity.SysUser;
import com.zhidao.mapper.SysUserMapper;
import com.zhidao.security.JwtUtil;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

/**
 * 认证服务。
 *
 * <p>两个安全细节容易被漏掉：
 * <ol>
 *   <li><b>用户名不存在与密码错误返回同一句话</b>。
 *       区分开来，等于提供一个免费的用户名枚举接口</li>
 *   <li><b>禁用状态的账号同样走"用户名或密码错误"</b>。
 *       "该账号已禁用"会告诉对方"这个用户名是对的"</li>
 * </ol>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AuthService {

    /** 统一失败话术。改这一句之前先想清楚它有没有在泄露信息 */
    private static final String LOGIN_FAILED = "用户名或密码错误";

    private final SysUserMapper userMapper;
    private final PasswordEncoder passwordEncoder;
    private final JwtUtil jwtUtil;

    public LoginResponse login(LoginRequest req) {
        SysUser user = userMapper.selectOne(new LambdaQueryWrapper<SysUser>()
                .eq(SysUser::getUsername, req.username()));

        // 故意不区分"用户不存在"和"密码错"
        if (user == null || !passwordEncoder.matches(req.password(), user.getPasswordHash())) {
            log.info("登录失败，用户名={}", req.username());
            throw new BizException(40101, LOGIN_FAILED);
        }
        if (Boolean.FALSE.equals(user.getEnabled())) {
            log.info("登录失败（已禁用），用户名={}", req.username());
            throw new BizException(40101, LOGIN_FAILED);
        }

        String token = jwtUtil.issue(user.getId(), user.getRole());
        log.info("登录成功 userId={}", user.getId());
        return new LoginResponse(token, user.getId(), user.getUsername(), user.getRole(),
                jwtUtil.expireSeconds());
    }
}
