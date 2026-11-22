package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.service.NoticeService;
import com.zhidao.vo.NoticeView;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 患者端 · 公告。
 *
 * <p>需要登录（由 {@code anyRequest().authenticated()} 兜底），
 * 但不限制角色：公告是给所有患者看的运营内容，
 * 要求 ROLE_PATIENT 反而会把医生账号挡在外面。
 *
 * <p>只返回已发布且已到发布时间的公告，草稿永远不会出现在这里。
 */
@RestController
@RequestMapping("/api/notices")
@RequiredArgsConstructor
public class NoticeController {

    private final NoticeService noticeService;

    @GetMapping
    public ApiResult<List<NoticeView>> list(@RequestParam(defaultValue = "3") int limit) {
        return ApiResult.ok(noticeService.listPublished(limit));
    }
}
