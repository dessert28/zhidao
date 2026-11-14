package com.zhidao.security;

import io.jsonwebtoken.Claims;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.util.AntPathMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * 把 Authorization 头里的 JWT 变成 SecurityContext 里的认证信息。
 *
 * <p>为什么不用 Spring Security 自带的 JWT 过滤器：
 * 官方那几个是给 OAuth2 资源服务器用的，为一张业务令牌拉进
 * {@code spring-boot-starter-oauth2-resource-server} 不合适。
 * 这里逻辑只有二十行，自己写反而更清楚在发生什么。
 *
 * <p><b>只放行，不拦截</b>：本过滤器不放行也不拒绝任何请求，
 * 没有合法令牌就保持"未认证"状态，具体能不能访问由
 * {@link com.zhidao.config.SecurityConfig} 的规则决定。
 * 一个过滤器里同时做认证和授权，早晚会漏掉一条路径。
 */
@Slf4j
@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private static final String BEARER = "Bearer ";

    /** 无需认证的路径：交给 SecurityConfig 判定，这里直接跳过省一次解析 */
    private static final List<String> PUBLIC_PATTERNS = List.of(
            "/api/auth/**",
            "/api/health",
            "/h2-console/**",
            "/v3/api-docs/**",
            "/swagger-ui/**",
            "/doc.html",
            "/webjars/**"
    );

    private final JwtUtil jwtUtil;
    private final AntPathMatcher matcher = new AntPathMatcher();

    public JwtAuthenticationFilter(JwtUtil jwtUtil) {
        this.jwtUtil = jwtUtil;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return PUBLIC_PATTERNS.stream().anyMatch(p -> matcher.match(p, path));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String header = request.getHeader("Authorization");

        // 已认证就不覆盖：允许上游（如测试里的 mock 认证）先放一个进去
        if (header != null && header.startsWith(BEARER)
                && SecurityContextHolder.getContext().getAuthentication() == null) {
            Claims claims = jwtUtil.parse(header.substring(BEARER.length()).trim());
            if (claims != null) {
                String role = claims.get("role", String.class);
                var auth = new UsernamePasswordAuthenticationToken(
                        Long.valueOf(claims.getSubject()),
                        null,
                        List.of(new SimpleGrantedAuthority("ROLE_" + (role == null ? "PATIENT" : role)))
                );
                SecurityContextHolder.getContext().setAuthentication(auth);
            }
        }

        chain.doFilter(request, response);
    }
}
