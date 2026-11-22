package com.zhidao.dto;

import jakarta.validation.constraints.Size;

/**
 * 管理端修改用户。
 *
 * <p>三个字段都可空，null 表示"这次不改这一项"。
 * 这与「传空字符串表示清空」是两种不同的语义，混在一起会让
 * 前端只提交部分字段时意外清掉别的内容（同 {@code ProfileUpdateRequest} 的取舍）。
 *
 * <p>不能用 {@code @NotBlank}：PATCH 语义下只改一个字段时，
 * 另外两个字段本来就不会出现在请求体里。
 */
public record AdminUserUpdateRequest(

        String role,

        Boolean enabled,

        @Size(max = 64, message = "展示名最长 64 位")
        String displayName
) {
}
