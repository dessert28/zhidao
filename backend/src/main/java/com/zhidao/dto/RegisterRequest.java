package com.zhidao.dto;

import jakarta.validation.constraints.AssertTrue;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * 注册请求。
 *
 * <p>手机号即登录名（{@code username}）：账号体系改为接受手机号后，
 * 不再另外引入一套账号名，避免"登录填手机号、系统里却叫别的名字"的分叉。
 * 姓名只存展示名，不做身份核验 —— 系统不绑真实身份。
 */
public record RegisterRequest(
        @NotBlank(message = "姓名不能为空")
        @Size(max = 32, message = "姓名不能超过 32 个字符")
        String name,

        @NotBlank(message = "手机号不能为空")
        @Pattern(regexp = "1\\d{10}", message = "请输入 11 位手机号")
        String phone,

        @NotBlank(message = "密码不能为空")
        @Size(min = 6, max = 64, message = "密码长度需在 6 到 64 位之间")
        String password,

        @AssertTrue(message = "请先阅读并同意用户协议与隐私政策")
        boolean agreed
) {
}
