package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.common.BizException;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 用户协议 / 隐私政策接口。
 *
 * <p>协议内容变更频繁且由运营侧维护，放后端可做到"改文本不发版"。
 * 当前正文内置在代码里（占位文案），后续换成数据库或 CMS 时只改本类内部，
 * 接口形状与前端都不用动。
 *
 * <p>这两个接口在 SecurityConfig 中放行：注册页在未登录状态就要展示协议，
 * 要求先登录是循环依赖。
 */
@RestController
@RequestMapping("/api/agreements")
@RequiredArgsConstructor
public class AgreementController {

    /** 链接列表：id + 展示名 + 前端路径 */
    @GetMapping
    public ApiResult<List<Map<String, String>>> list() {
        return ApiResult.ok(List.of(
                Map.of("id", "terms", "label", "用户协议", "href", "/legal/terms"),
                Map.of("id", "privacy", "label", "隐私政策", "href", "/legal/privacy")
        ));
    }

    /** 协议正文 */
    @GetMapping("/{id}")
    public ApiResult<Map<String, Object>> detail(@PathVariable String id) {
        Map<String, Object> doc = switch (id) {
            case "terms" -> Map.of(
                    "id", "terms",
                    "title", "用户协议",
                    "updatedAt", "2026-11-19",
                    "sections", List.of(
                            section("关于本系统", "智诊通仅做信息整理、风险提示与就诊准备，不提供诊断、用药或停药建议。如有急症请立即拨打 120。"),
                            section("账号与数据", "注册使用手机号作为登录名，不收集身份证件信息。您的健康数据仅用于为您提供本系统功能。"),
                            section("正式条款", "当前为演示版本条款；正式用户协议由运营侧发布后通过本接口下发，页面无需改动。")
                    ));
            case "privacy" -> Map.of(
                    "id", "privacy",
                    "title", "隐私政策",
                    "updatedAt", "2026-11-19",
                    "sections", List.of(
                            section("信息收集", "注册时收集手机号（作为登录名）与姓名（仅作展示），不收集身份证件号码。"),
                            section("信息使用", "您录入的症状、病历与用药信息仅用于本系统的整理与提示，不作为诊断依据。"),
                            section("演示说明", "演示环境下数据存于内存数据库，进程重启后即清空。正式隐私政策由运营侧发布后通过本接口下发。")
                    ));
            default -> throw new BizException(40401, "协议不存在");
        };
        return ApiResult.ok(doc);
    }

    private static Map<String, String> section(String heading, String body) {
        return Map.of("heading", heading, "body", body);
    }
}
