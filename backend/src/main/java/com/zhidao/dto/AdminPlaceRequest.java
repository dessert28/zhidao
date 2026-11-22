package com.zhidao.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 管理端新增院内地点。
 *
 * <p>没有 {@code id} 与 {@code hospitalCode}：前者由数据库生成，
 * 后者来自路径。请求体里带这两个字段会让"改哪家院区的地点"
 * 出现两个互相矛盾的信息源。
 *
 * <p>{@code placeType} 与 {@code dataQuality} 的枚举校验在 Service 里做，
 * 因为它们的合法值集合是业务规则（导航阶段依赖 placeType 的顺序），
 * 不是单纯的长度/非空约束。
 */
public record AdminPlaceRequest(

        @NotBlank(message = "地点类型不能为空")
        String placeType,

        @Size(max = 64, message = "科室最长 64 位")
        String department,

        @NotBlank(message = "地点名称不能为空")
        @Size(max = 128, message = "地点名称最长 128 位")
        String name,

        @Size(max = 64, message = "楼栋最长 64 位")
        String building,

        @Size(max = 20, message = "楼层最长 20 位")
        String floor,

        @Size(max = 500, message = "指引最长 500 位")
        String directions,

        @Size(max = 200, message = "服务时间最长 200 位")
        String openHours,

        Integer estMinutes,

        Integer sortOrder,

        String dataQuality
) {
}
