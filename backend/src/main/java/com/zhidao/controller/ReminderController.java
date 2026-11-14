package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.entity.ReminderTask;
import com.zhidao.security.CurrentUser;
import com.zhidao.service.ReminderEngine;
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
    private final ReminderEngine reminderEngine;

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

    /**
     * 手工触发一次扫描。
     *
     * <p>为什么要这个接口：定时任务每 5 分钟才跑一次，
     * 而答辩 / 演示只有几分钟。等 5 分钟看一条提醒出现，现场体验很差。
     *
     * <p>为什么不是"只扫当前用户"：引擎的规则是跨用户全量扫的
     * （复查到期这类判断与是谁无关），这里直接复用同一条链路，
     * 保证"手工触发"和"定时触发"跑的是<b>同一段代码</b>——
     * 各写一份的话，演示时能出提醒、线上不出，是最难查的那种问题。
     *
     * <p>幂等由 dedupe_key 保证，点几次都不会重复插入。
     *
     * @return 本次新生成的提醒条数（0 表示确实没有新的）
     */
    @PostMapping("/scan")
    public ApiResult<java.util.Map<String, Object>> scan() {
        int created = reminderEngine.scanOnce(java.time.LocalDateTime.now());
        return ApiResult.ok(java.util.Map.of("created", created));
    }
}
