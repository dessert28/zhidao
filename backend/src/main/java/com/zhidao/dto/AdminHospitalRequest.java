package com.zhidao.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 管理端新增 / 修改院区。
 *
 * <p>{@code hospitalCode} 在 POST 里是业务主键；在 PUT 里以路径参数为准，
 * 请求体里的值会被忽略 —— 允许改编码等于允许把一条预约单指向另一家医院，
 * 而预约单存的就是这个编码。这条约束写在 Controller 注释里，不在这里。
 */
public record AdminHospitalRequest(

        @Size(max = 32, message = "院区编码最长 32 位")
        String hospitalCode,

        @NotBlank(message = "院区名称不能为空")
        @Size(max = 128, message = "院区名称最长 128 位")
        String name,

        @Size(max = 32, message = "院区等级最长 32 位")
        String level,

        @Size(max = 64, message = "城市最长 64 位")
        String city,

        @Size(max = 32, message = "适配器类型最长 32 位")
        String adapterType,

        Boolean enabled
) {
}
