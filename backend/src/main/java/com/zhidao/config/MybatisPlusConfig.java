package com.zhidao.config;

import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * MyBatis-Plus 插件配置。
 *
 * <p><b>为什么必须有这个类</b>：MyBatis-Plus 的分页不是"默认能力"。
 * {@code selectPage} 只负责把 {@code Page} 里的 current/size 拼成 SQL 的
 * {@code LIMIT}，以及把 {@code COUNT(*)} 的结果回填到 {@code total} ——
 * 这两件事都由 {@link PaginationInnerInterceptor} 做。
 * 不注册它，{@code selectPage} 会退化成"查全表再内存切片"，
 * {@code total} 恒为 0。前端拿到 {@code total:0} 时不会报错，
 * 只会安静地不显示分页条 —— 这种"看起来能用"的故障最难查。
 *
 * <p><b>为什么 {@code PaginationInnerInterceptor} 不传 {@code DbType}</b>：
 * 本项目两个运行环境分别是 H2（省赛，默认）与 MySQL 8（国赛，profile=mysql）。
 * 显式写死 {@code DbType.MYSQL} 会让 H2 下的分页 SQL 带上 MySQL 方言；
 * 写死 {@code DbType.H2} 则反过来。不传时插件会从连接的
 * {@code DatabaseMetaData} 里识别方言，两边都能用 ——
 * 代价是每次首次分页多一次元数据读取，这对课设的数据量完全不值一提。
 */
@Configuration
public class MybatisPlusConfig {

    @Bean
    public MybatisPlusInterceptor mybatisPlusInterceptor() {
        MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
        interceptor.addInnerInterceptor(new PaginationInnerInterceptor());
        return interceptor;
    }
}
