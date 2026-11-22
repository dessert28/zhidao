package com.zhidao.vo;

/**
 * 管理端院内地点视图。
 *
 * <p>字段与 {@code hospital_place} 一一对应，但去掉审计列与
 * {@code hospitalCode} —— 后者来自请求路径，列表里每行都一样，
 * 重复返回只会让前端多一个可能与路径不一致的字段。
 */
public record AdminPlaceView(
        Long id,
        String placeType,
        String department,
        String name,
        String building,
        String floor,
        String directions,
        String openHours,
        Integer estMinutes,
        Integer sortOrder,
        String dataQuality
) {
}
