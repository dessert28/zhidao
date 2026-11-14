package com.zhidao.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhidao.common.ApiResult;
import com.zhidao.security.JwtAuthenticationFilter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

import java.nio.charset.StandardCharsets;

/**
 * 安全配置。
 *
 * <p>三件事，每件都对应一个具体的坑：
 * <ol>
 *   <li><b>无状态</b>：{@code SessionCreationPolicy.STATELESS}。
 *       比赛要求单实例部署且不引 Redis（docs/10 D6），
 *       一开 session 就直接绑死在单机内存上</li>
 *   <li><b>关 CSRF</b>：没有 Cookie 会话，CSRF 无从谈起；
 *       留着它反而会让所有 POST 接口 403</li>
 *   <li><b>401 也要返回统一响应体</b>：默认的 Spring 错误页是 HTML，
 *       前端 {@code res.json()} 会直接解析失败，表现为"点了没反应"</li>
 * </ol>
 */
@Configuration
public class SecurityConfig {

    /**
     * 401/403 的响应体由这个 mapper 序列化。
     *
     * <p><b>必须用 Spring 容器里的那个 bean，不能自己 new</b>：
     * 裸 {@code new ObjectMapper()} 没注册 JavaTimeModule，
     * 序列化 {@code ApiResult.timestamp}（LocalDateTime）时直接抛
     * InvalidDefinitionException —— 结果是 401 变成一个空的 401，
     * 前端 res.json() 照样炸。这个坑是集成测试抓出来的。
     */
    private final ObjectMapper objectMapper;

    public SecurityConfig(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        // BCrypt 自带盐，同一密码每次哈希都不同 —— 种子数据里的哈希只是它的一种
        return new BCryptPasswordEncoder();
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http, JwtAuthenticationFilter jwtFilter)
            throws Exception {
        http
                .csrf(AbstractHttpConfigurer::disable)
                .cors(AbstractHttpConfigurer::disable) // 同源部署，BFF 在另一个端口时由 Vite 代理
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .headers(h -> h.frameOptions(f -> f.sameOrigin())) // H2 控制台是 iframe
                .authorizeHttpRequests(auth -> auth
                        .requestMatchers(
                                "/api/auth/**",
                                "/api/health",
                                "/h2-console/**",
                                "/v3/api-docs/**",
                                "/swagger-ui/**",
                                "/doc.html",
                                "/webjars/**"
                        ).permitAll()
                        .anyRequest().authenticated()
                )
                .exceptionHandling(e -> e
                        .authenticationEntryPoint((req, res, ex) ->
                                writeJson(res, HttpStatus.UNAUTHORIZED, 40100, "请先登录"))
                        .accessDeniedHandler((req, res, ex) ->
                                writeJson(res, HttpStatus.FORBIDDEN, 40300, "没有访问权限"))
                )
                .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }

    /** 把统一响应体写进 401/403，避免前端拿到一坨 HTML */
    private void writeJson(jakarta.servlet.http.HttpServletResponse res,
                           HttpStatus status, int code, String message) throws java.io.IOException {
        res.setStatus(status.value());
        res.setContentType("application/json;charset=UTF-8");
        res.getOutputStream().write(
                objectMapper.writeValueAsString(ApiResult.fail(code, message))
                        .getBytes(StandardCharsets.UTF_8));
    }
}
