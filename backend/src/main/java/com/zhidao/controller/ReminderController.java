package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.entity.ReminderTask;
import com.zhidao.security.CurrentUser;
import com.zhidao.service.ReminderService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/** 提醒查询与用户动作。生成逻辑在 ReminderEngine，不在这里触发 */
@RestController
@RequestMapping("/api/reminders")
@RequiredArgsConstructor
public class ReminderController {

    private final ReminderService reminderService;

    /** 待处理提醒 —— 首页"接下来要做的事"的数据源 */
    @GetMapping
    public ApiResult<List<ReminderTask>> pending() {
        return ApiResult.ok(reminderService.pending(CurrentUser.id()));
    }

    @GetMapping("/all")
    public ApiResult<List<ReminderTask>> all() {
        return ApiResult.ok(reminderService.all(CurrentUser.id()));
    }

    @PostMapping("/{id}/done")
    public ApiResult<ReminderTask> done(@PathVariable long id) {
        return ApiResult.ok(reminderService.mark(CurrentUser.id(), id, ReminderTask.STATUS_DONE));
    }

    @PostMapping("/{id}/skip")
    public ApiResult<ReminderTask> skip(@PathVariable long id) {
        return ApiResult.ok(reminderService.mark(CurrentUser.id(), id, ReminderTask.STATUS_SKIPPED));
    }
}
