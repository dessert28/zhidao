package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.entity.BookingOrder;
import com.zhidao.security.CurrentUser;
import com.zhidao.service.BookingService;
import com.zhidao.service.VisitProgressService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 就诊流程进度 —— 患者自己标记"我走到哪了"。
 *
 * <p><b>为什么这个需求是真实的</b>：路线上的 DONE / CURRENT / UPCOMING
 * 原本完全由时间推算。真实门诊里时间经常不准 —— 抽血排队、
 * 医生临时取消某项检查、患者中途去缴费。系统说"该去诊区了"，
 * 人还在抽血窗口前；或者系统说"下一步是检验"，其实医生说不用做。
 *
 * <p>这种时候只有患者自己知道实际情况。让他能手动推进，
 * 比让系统一直说得不准要好。
 *
 * <p><b>挂载位置</b>：放在 /api/bookings/{id}/progress 而不是 /api/nav 下。
 * 理由：进度属于"某一张预约单"，和导航路线那种无状态的查询不是一类东西。
 * 而且它需要登录（要按用户隔离），而 /api/nav 是匿名开放的 ——
 * 混在一个前缀下容易让人以为它也公开。
 */
@RestController
@RequestMapping("/api/bookings/{id}/progress")
@RequiredArgsConstructor
public class VisitProgressController {

    private final VisitProgressService progressService;
    private final BookingService bookingService;

    /**
     * 读这一单的手动进度。
     *
     * @return navKey → state（DONE / SKIPPED）
     */
    @GetMapping
    public ApiResult<Map<String, String>> list(@PathVariable long id) {
        long userId = CurrentUser.id();
        // 先过一遍归属校验：get 会抛 404，不会让人读到别人的单
        bookingService.get(userId, id);
        return ApiResult.ok(progressService.progressOf(userId, id));
    }

    /**
     * 标记（或清除）某一步。
     *
     * <p>请求体 {@code {navKey, state}}：state 传 DONE / SKIPPED 表示标记，
     * 传空串表示清除（回到按时间推算的默认值）。
     *
     * <p>用 POST 而不是 PATCH：这个动作是"设置成某种状态"，
     * 不是局部修改一个资源，POST 更贴合语义。清除同样走这个接口，
     * 少一个方法就少一处不一致。
     */
    @PostMapping
    public ApiResult<Map<String, Object>> mark(
            @PathVariable long id,
            @RequestBody Map<String, String> body) {

        long userId = CurrentUser.id();
        bookingService.get(userId, id);

        String navKey = body.get("navKey");
        String state = body.get("state");

        Map<String, String> updated = progressService.mark(userId, id, navKey, state);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("progress", updated);
        data.put("bookingId", id);
        return ApiResult.ok(data);
    }

    /**
     * 清除这一单的全部手动进度。
     *
     * <p>场景：患者标错了想全部重来，或者就诊结束后清理。
     * 清除后路线回到纯时间推算 —— 那是一个明确的、可预期的默认状态。
     */
    @DeleteMapping
    public ApiResult<Map<String, Object>> reset(@PathVariable long id) {
        long userId = CurrentUser.id();
        bookingService.get(userId, id);
        // 逐条清除等价于清空全部：mark 传空 state 就是这个语义
        Map<String, String> current = progressService.progressOf(userId, id);
        for (String key : current.keySet()) {
            progressService.mark(userId, id, key, "");
        }
        return ApiResult.ok(Map.of("bookingId", id, "cleared", true));
    }
}
