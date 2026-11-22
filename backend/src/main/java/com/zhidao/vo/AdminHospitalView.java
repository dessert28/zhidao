package com.zhidao.vo;

/**
 * 管理端院区列表项。
 *
 * <p>{@code placeCount} 是院内地点数量。放在列表里而不是让前端
 * 逐行再请求一次：管理页第一屏就要回答"这家院区配全了没有"，
 * 没有这个数字，运营得点进每一家才知道哪家是空的。
 *
 * <p>它的口径是<b>未删除</b>的地点条数，与导航实际可用的数据一致；
 * 把已逻辑删除的也算进去，会让人误以为某院区导航已经配好。
 */
public record AdminHospitalView(
        String hospitalCode,
        String name,
        String level,
        String city,
        String adapterType,
        Boolean enabled,
        long placeCount
) {
}
