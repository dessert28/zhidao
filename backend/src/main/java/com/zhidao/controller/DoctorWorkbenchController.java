package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.common.PageResult;
import com.zhidao.service.DoctorPatientService;
import com.zhidao.vo.DoctorPatientView;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

/**
 * 医生工作台 · 患者。
 *
 * <p>权限规则写在 {@link com.zhidao.config.SecurityConfig}：
 * {@code /api/doctor/patients/** -> hasAnyRole("DOCTOR","ADMIN")}。
 * 允许 ADMIN 是为了让管理员能在没有医生账号的环境里核对数据，
 * 而不是给患者开一个入口。
 *
 * <p>与 {@code /api/doctor/brief/**} 的区别见
 * {@link com.zhidao.service.DoctorPatientService} 的类注释：
 * 那条路是一次性免登录链接，这条路需要医生身份，两套契约互不影响。
 */
@RestController
@RequestMapping("/api/doctor/patients")
@RequiredArgsConstructor
public class DoctorWorkbenchController {

    private final DoctorPatientService doctorPatientService;

    @GetMapping
    public ApiResult<PageResult<DoctorPatientView>> page(
            @RequestParam(required = false) String keyword,
            @RequestParam(defaultValue = "1") long page,
            @RequestParam(defaultValue = "20") long size) {
        return ApiResult.ok(doctorPatientService.page(keyword, page, size));
    }

    /**
     * 患者详情。
     *
     * <p>{@code userId} 从路径读取是安全的：这个接口本身已经要求医生身份，
     * 医生查看任意患者是业务允许的。患者端不提供同类接口 ——
     * 那里必须用 {@code CurrentUser.id()}，不能接受用户 id 参数。
     */
    @GetMapping("/{userId}")
    public ApiResult<DoctorPatientView> detail(@PathVariable long userId) {
        return ApiResult.ok(doctorPatientService.detail(userId));
    }
}
