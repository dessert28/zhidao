package com.zhidao.common;

import java.util.List;

/**
 * 分页结果。
 *
 * <p>为什么不直接把 MyBatis-Plus 的 {@code IPage} 返回到 Controller：
 * 它带着 {@code optimizeCountSql}、{@code searchCount}、{@code orders} 这些
 * 只有 SQL 层才关心的字段。前端拿到一个"什么都有"的对象，
 * 下一步就会有人开始依赖其中某个内部字段，然后一次升级就全线崩。
 * 这里只留四个真正属于接口契约的数字。
 *
 * @param records       当前页数据
 * @param total         总条数
 * @param page          页码，从 1 开始
 * @param size          每页条数
 */
public record PageResult<T>(List<T> records, long total, long page, long size) {

    public static <T> PageResult<T> of(List<T> records, long total, long page, long size) {
        return new PageResult<>(records, total, page, size);
    }
}
