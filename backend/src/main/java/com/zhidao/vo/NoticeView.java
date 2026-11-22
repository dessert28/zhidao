package com.zhidao.vo;

import java.time.LocalDateTime;

/**
 * 公告视图，管理端与患者端共用。
 *
 * <p><b>为什么两端共用一个 record</b>：两端看到的字段本来就一样。
 * 患者端多一道 {@code status=PUBLISHED && publishedAt <= now} 的过滤，
 * 但过滤后的数据形状没有区别。为两边各定义一个视图，
 * 只会让"管理端加了字段、患者端忘了加"这种不一致有机会发生。
 *
 * <p>草稿不会出现在患者端，所以 {@code status} 对患者恒为 PUBLISHED；
 * 保留字段是为了让管理端复用同一个类型。
 *
 * <p>{@code createdAt} 留在视图里，是因为草稿没有发布时间，
 * 管理端列表要显示"这条是什么时候写的"。前端按
 * {@code publishedAt ?? createdAt} 展示，两者缺一都会让草稿那行变成空白。
 */
public record NoticeView(
        Long id,
        String title,
        String content,
        String level,
        Boolean pinned,
        String status,
        LocalDateTime publishedAt,
        LocalDateTime createdAt
) {
}
