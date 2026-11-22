package com.zhidao.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 管理端新增 / 修改公告。
 *
 * <p>不接收 {@code publishedAt}：发布时间由服务端决定。
 * 让前端传时间会有两个问题：一是客户端时钟不可信，
 * 二是"到点自动发布"就变成了"前端记得在到点时再调一次接口"。
 */
public record NoticeRequest(

        @NotBlank(message = "标题不能为空")
        @Size(max = 200, message = "标题最长 200 位")
        String title,

        @NotBlank(message = "正文不能为空")
        String content,

        String level,

        Boolean pinned,

        String status
) {
}
