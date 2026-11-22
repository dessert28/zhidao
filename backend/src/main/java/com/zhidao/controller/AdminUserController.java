package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.common.PageResult;
import com.zhidao.dto.AdminUserCreateRequest;
import com.zhidao.dto.AdminUserUpdateRequest;
import com.zhidao.security.CurrentUser;
import com.zhidao.service.AdminUserService;
import com.zhidao.vo.AdminUserView;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * 管理端 · 用户管理。
 *
 * <p>权限由 {@link com.zhidao.config.SecurityConfig} 的
 * {@code /api/admin/** -> hasRole("ADMIN")} 统一拦截。
 * 前端隐藏菜单<b>不算权限</b>：任何一个登录用户都能手敲这个 URL，
 * 真正的边界只在过滤器链上。
 *
 * <p>所有写操作都把 {@link CurrentUser#id()} 传给 Service：
 * "不能改自己/不能删自己/不能删最后一个管理员"这些保护
 * 需要知道"谁在操作"，而操作人只能来自签名过的令牌，
 * 不能由请求体声明。
 */
@RestController
@RequestMapping("/api/admin/users")
@RequiredArgsConstructor
public class AdminUserController {

    private final AdminUserService userService;

    @GetMapping
    public ApiResult<PageResult<AdminUserView>> page(
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String role,
            @RequestParam(defaultValue = "1") long page,
            @RequestParam(defaultValue = "20") long size) {
        return ApiResult.ok(userService.page(keyword, role, page, size));
    }

    /** 返回 {@code {id}} 而不是整个用户：前端建完只需要跳转详情或刷新列表 */
    @PostMapping
    public ApiResult<Map<String, Object>> create(@Valid @RequestBody AdminUserCreateRequest req) {
        Long id = userService.create(req);
        return ApiResult.ok(Map.of("id", id));
    }

    /**
     * 局部更新。
     *
     * <p>用 PATCH 而不是 PUT：这个接口的语义就是"只改传过来的字段"。
     * 用 PUT 会让人以为没传的字段应该被清空，而 enabled 被误清空
     * 就等于禁用账号。
     */
    @PatchMapping("/{id}")
    public ApiResult<Void> update(@PathVariable long id,
                                  @Valid @RequestBody AdminUserUpdateRequest req) {
        userService.update(CurrentUser.id(), id, req);
        return ApiResult.ok();
    }

    @DeleteMapping("/{id}")
    public ApiResult<Void> delete(@PathVariable long id) {
        userService.delete(CurrentUser.id(), id);
        return ApiResult.ok();
    }
}
