package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.common.PageResult;
import com.zhidao.dto.NoticeRequest;
import com.zhidao.service.NoticeService;
import com.zhidao.vo.NoticeView;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

/**
 * 管理端 · 公告。
 *
 * <p>与患者端 {@link NoticeController} 共用同一个 Service 与视图类型，
 * 区别只在权限与过滤条件：这里能看到草稿，患者端只能看到
 * 已发布且已到发布时间的公告。
 */
@RestController
@RequestMapping("/api/admin/notices")
@RequiredArgsConstructor
public class AdminNoticeController {

    private final NoticeService noticeService;

    @GetMapping
    public ApiResult<PageResult<NoticeView>> page(
            @RequestParam(defaultValue = "1") long page,
            @RequestParam(defaultValue = "20") long size) {
        return ApiResult.ok(noticeService.page(page, size));
    }

    @PostMapping
    public ApiResult<Void> create(@Valid @RequestBody NoticeRequest req) {
        noticeService.create(req);
        return ApiResult.ok();
    }

    @PutMapping("/{id}")
    public ApiResult<Void> update(@PathVariable long id,
                                  @Valid @RequestBody NoticeRequest req) {
        noticeService.update(id, req);
        return ApiResult.ok();
    }

    @DeleteMapping("/{id}")
    public ApiResult<Void> delete(@PathVariable long id) {
        noticeService.delete(id);
        return ApiResult.ok();
    }
}
