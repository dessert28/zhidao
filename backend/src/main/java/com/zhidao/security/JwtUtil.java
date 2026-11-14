package com.zhidao.security;

import com.zhidao.config.JwtProperties;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;

/**
 * JWT 签发与校验。
 *
 * <p>令牌里放什么、<b>不放什么</b>，是这一层最重要的设计：
 * <ul>
 *   <li>放：{@code sub}=用户 id、{@code role}。够用即可</li>
 *   <li>不放：用户名以外的任何患者信息。JWT 是<b>明文可见</b>的（只签名不加密），
 *       把生日、过敏史塞进去等于把病历写在信封外面</li>
 * </ul>
 *
 * <p>校验失败一律返回 {@code null}，不区分"过期"和"伪造"。
 * 给调用方两种不同的错误码，等于告诉攻击者"你这个签名是对的，只是过期了"，
 * 他换一个时间戳就能再用一次。
 */
@Slf4j
@Component
public class JwtUtil {

    private final JwtProperties props;
    private final SecretKey key;

    public JwtUtil(JwtProperties props) {
        this.props = props;
        this.key = Keys.hmacShaKeyFor(props.getSecret().getBytes(StandardCharsets.UTF_8));
    }

    /**
     * 签发令牌。
     *
     * @param userId 用户 id，放在 sub 里
     * @param role   角色，如 PATIENT
     */
    public String issue(long userId, String role) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(String.valueOf(userId))
                .claim("role", role)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusSeconds(props.getExpireMinutes() * 60L)))
                .signWith(key)
                .compact();
    }

    /** 解析令牌；任何异常（过期/篡改/格式错）都返回 null */
    public Claims parse(String token) {
        if (token == null || token.isBlank()) {
            return null;
        }
        try {
            return Jwts.parser()
                    .verifyWith(key)
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();
        } catch (JwtException | IllegalArgumentException e) {
            // 只记类型，不记 token 本身 —— 日志里的 token 和明文密码一样危险
            log.debug("令牌校验失败: {}", e.getClass().getSimpleName());
            return null;
        }
    }

    public long expireSeconds() {
        return props.getExpireMinutes() * 60L;
    }
}
