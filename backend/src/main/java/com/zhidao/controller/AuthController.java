package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.dto.LoginRequest;
import com.zhidao.dto.LoginResponse;
import com.zhidao.dto.RegisterRequest;
import com.zhidao.service.AuthService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** 认证接口。/api/auth/** 在 SecurityConfig 里整体放行 */
@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;

    /** 演示账号：demo / demo1234（种子数据，非密钥） */
    @PostMapping("/login")
    public ApiResult<LoginResponse> login(@Valid @RequestBody LoginRequest req) {
        return ApiResult.ok(authService.login(req));
    }

    /** 注册。手机号即登录名，成功后直接返回 token */
    @PostMapping("/register")
    public ApiResult<LoginResponse> register(@Valid @RequestBody RegisterRequest req) {
        return ApiResult.ok(authService.register(req));
    }
}
