package com.zhidao.dto;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;

/**
 * 更新患者档案。
 *
 * <p><b>刻意只有这四个字段</b>。没有任何地方能通过接口写入真名、身份证、
 * 手机号、住址 —— 不是漏写，是 schema 里就没有这些列（docs/09 硬约束之一）。
 *
 * <p>过敏史与慢病用逗号分隔字符串而不是 JSON：
 * 调用方是前端表单，让它拼 JSON 只会多出一个出错点，
 * Service 层负责转成存储用的 JSON 数组。
 *
 * @param birthYear 出生年份。{@code @Min/@Max} 在这里不是形式主义：
 *                  写错成 196 或 19650 会让"年龄"算出来是负数或两千岁，
 *                  而这个值会直接进分诊上下文
 * @param gender    MALE / FEMALE / OTHER
 * @param allergies 逗号分隔，如 "青霉素,磺胺"
 * @param chronics  逗号分隔，如 "高血压,2型糖尿病"
 */
public record ProfileUpdateRequest(
        @Min(value = 1900, message = "出生年份不早于 1900")
        @Max(value = 2100, message = "出生年份不晚于 2100")
        Integer birthYear,

        String gender,

        String allergies,

        String chronics
) {
}
