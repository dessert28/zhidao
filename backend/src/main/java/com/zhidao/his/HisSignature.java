package com.zhidao.his;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

/**
 * 院方接入的签名算法。
 *
 * <h3>为什么用 HMAC-SHA256 而不是简单的 "密钥放在 header 里"</h3>
 *
 * <p>把 secret 直接放进 header，任何能看日志、能抓包的人都能拿到它，
 * 然后冒充这家医院推送任意数据。HMAC 签名让**密钥本身不出现在请求里**，
 * 每次请求带的是"用密钥算出来的值"—— 抓到也没法反推密钥，
 * 且无法伪造新请求（改动任何一个字符，签名就对不上）。
 *
 * <h3>签名串怎么拼</h3>
 *
 * <pre>
 *   stringToSign = METHOD + "\n"
 *                + PATH     + "\n"
 *                + TIMESTAMP + "\n"
 *                + NONCE    + "\n"
 *                + SHA256(body)
 * </pre>
 *
 * <p>四个要素各有作用，缺一个都会留下攻击面：
 * <ul>
 *   <li><b>METHOD + PATH</b>：不签的话，一个合法的 GET 签名可以被拿去调 DELETE</li>
 *   <li><b>TIMESTAMP</b>：防止重放。超过允许时间窗的请求直接拒绝</li>
 *   <li><b>NONCE</b>：同一时间窗内防重放（时间戳精度不够时兜底）</li>
 *   <li><b>body 的 SHA256</b>：不签 body 的话，签名对但内容可以被随意篡改</li>
 * </ul>
 *
 * <p><b>为什么 body 用 SHA256 的十六进制而不是原文</b>：
 * 原文可能很长（一批地点几十 KB），直接拼进签名串会让签名计算变慢，
 * 而且原文里的换行/编码差异会导致签名不稳定。哈希后长度固定、只含 ASCII。
 */
public final class HisSignature {

    private HisSignature() {
    }

    /** 允许的时间偏差。5 分钟是常见取值：足够容忍时钟漂移，又不至于让重放窗口太大 */
    public static final long TIMESTAMP_TOLERANCE_SECONDS = 300;

    /**
     * 计算签名。
     *
     * @param secret 院方的 appSecret
     * @param method HTTP 方法（大写）
     * @param path   请求路径，不含 host 与 query
     * @param timestamp 秒级时间戳
     * @param nonce  一次性随机串
     * @param body   请求体原文（GET 传空串）
     * @return 小写十六进制签名
     */
    public static String sign(
            String secret, String method, String path,
            String timestamp, String nonce, String body) {

        String bodyHash = sha256Hex(body == null ? "" : body);
        String toSign = String.join("\n",
                method.toUpperCase(),
                path,
                timestamp,
                nonce,
                bodyHash);
        return hmacSha256Hex(secret, toSign);
    }

    /**
     * 验签。
     *
     * <p>用 {@link MessageDigest#isEqual} 做**常量时间比较**：
     * 普通的 {@code String.equals} 会在第一个不同字节处提前返回，
     * 攻击者可以通过响应时间差异逐字节猜出正确签名。
     * 这不是过度设计 —— 签名校验是唯一防线时，时序侧信道是真实的。
     */
    public static boolean verify(
            String secret, String method, String path,
            String timestamp, String nonce, String body, String providedSignature) {

        if (providedSignature == null || providedSignature.isBlank()) return false;
        String expected = sign(secret, method, path, timestamp, nonce, body);
        return MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.US_ASCII),
                providedSignature.toLowerCase().getBytes(StandardCharsets.US_ASCII));
    }

    /**
     * 时间戳是否在允许窗口内。
     *
     * @param timestamp 院方给的秒级时间戳
     * @param nowSeconds 当前秒级时间戳
     */
    public static boolean timestampAcceptable(long timestamp, long nowSeconds) {
        return Math.abs(nowSeconds - timestamp) <= TIMESTAMP_TOLERANCE_SECONDS;
    }

    static String sha256Hex(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            // SHA-256 是 JDK 必备算法，走不到这里；真的走不到就抛出而不是返回空
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }

    static String hmacSha256Hex(String secret, String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(data.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException("HmacSHA256 不可用", e);
        }
    }
}
