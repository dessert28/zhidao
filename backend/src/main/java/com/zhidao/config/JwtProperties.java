package com.zhidao.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * JWT 配置，对应 application.yml 的 {@code zhidao.jwt.*}。
 *
 * <p>用 {@code @ConfigurationProperties} 而不是满地的 {@code @Value}：
 * 密钥、有效期这类东西一旦散落在十几个类里，
 * 改一次配置就要全文搜索一遍，而且拼错字段名只会在运行时炸。
 */
@Data
@Component
@ConfigurationProperties(prefix = "zhidao.jwt")
public class JwtProperties {

    /** 签名密钥；生产必须从环境变量注入，不能留在仓库里 */
    private String secret;

    /** 过期分钟数 */
    private int expireMinutes = 120;
}
