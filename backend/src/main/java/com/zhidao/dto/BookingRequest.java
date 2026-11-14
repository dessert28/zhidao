package com.zhidao.dto;

import jakarta.validation.constraints.Future;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import java.time.LocalDateTime;

/**
 * 建预约单请求。
 *
 * <p>{@code @Future} 拦掉"约到昨天"这种输入。它看着多余，
 * 但排程 Agent 拼错一个年份（2025 → 2024）就会造出一张永远不会到期的单子，
 * 而提醒引擎会为它排一条永远不触发的提醒 —— 这种静默错误最难查。
 */
public record BookingRequest(
        @NotBlank(message = "院区编码不能为空") String hospitalCode,
        @NotBlank(message = "科室不能为空") String department,
        @NotNull(message = "就诊时间不能为空") @Future(message = "就诊时间必须在将来") LocalDateTime visitTime,
        String remark
) {
}
