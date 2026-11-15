package com.zhidao.his;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 签名算法测试。
 *
 * <p>这块测错一个字节，院方就接不进来；测松一处，别人就能伪造推送。
 * 所以两个方向都测：能正确验签，以及各种篡改都验不过。
 */
@DisplayName("HIS 签名：能验真，也要挡住篡改")
class HisSignatureTest {

    private static final String SECRET = "test-secret";
    private static final String METHOD = "POST";
    private static final String PATH = "/api/his/places";
    private static final String TS = "1763200000";
    private static final String NONCE = "abc123";
    private static final String BODY = "{\"batchId\":\"b1\"}";

    @Test
    @DisplayName("同一个输入算出的签名稳定")
    void deterministic() {
        String a = HisSignature.sign(SECRET, METHOD, PATH, TS, NONCE, BODY);
        String b = HisSignature.sign(SECRET, METHOD, PATH, TS, NONCE, BODY);
        assertThat(a).isEqualTo(b);
        assertThat(a).matches("[0-9a-f]{64}");
    }

    @Test
    @DisplayName("正确签名能通过校验")
    void verifyOk() {
        String sig = HisSignature.sign(SECRET, METHOD, PATH, TS, NONCE, BODY);
        assertThat(HisSignature.verify(SECRET, METHOD, PATH, TS, NONCE, BODY, sig)).isTrue();
    }

    @Test
    @DisplayName("大写签名也接受（院方实现可能输出大写）")
    void acceptsUppercase() {
        String sig = HisSignature.sign(SECRET, METHOD, PATH, TS, NONCE, BODY).toUpperCase();
        assertThat(HisSignature.verify(SECRET, METHOD, PATH, TS, NONCE, BODY, sig)).isTrue();
    }

    /* ============================ 篡改必须挡住 ============================ */

    @Test
    @DisplayName("改 body → 验签失败")
    void tamperedBodyFails() {
        String sig = HisSignature.sign(SECRET, METHOD, PATH, TS, NONCE, BODY);
        assertThat(HisSignature.verify(SECRET, METHOD, PATH, TS, NONCE,
                "{\"batchId\":\"b2\"}", sig)).isFalse();
    }

    @Test
    @DisplayName("改 path → 验签失败（防签名跨接口复用）")
    void tamperedPathFails() {
        String sig = HisSignature.sign(SECRET, METHOD, PATH, TS, NONCE, BODY);
        assertThat(HisSignature.verify(SECRET, "/api/his/other", PATH, TS, NONCE, BODY, sig))
                .isFalse();
    }

    @Test
    @DisplayName("改 method → 验签失败（防 GET 签名被拿去发 POST）")
    void tamperedMethodFails() {
        String sig = HisSignature.sign(SECRET, "GET", PATH, TS, NONCE, BODY);
        assertThat(HisSignature.verify(SECRET, "POST", PATH, TS, NONCE, BODY, sig)).isFalse();
    }

    @Test
    @DisplayName("改 nonce → 验签失败")
    void tamperedNonceFails() {
        String sig = HisSignature.sign(SECRET, METHOD, PATH, TS, NONCE, BODY);
        assertThat(HisSignature.verify(SECRET, METHOD, PATH, TS, "other-nonce", BODY, sig))
                .isFalse();
    }

    @Test
    @DisplayName("换密钥 → 验签失败")
    void wrongSecretFails() {
        String sig = HisSignature.sign(SECRET, METHOD, PATH, TS, NONCE, BODY);
        assertThat(HisSignature.verify("wrong-secret", METHOD, PATH, TS, NONCE, BODY, sig))
                .isFalse();
    }

    @Test
    @DisplayName("空签名/空串 → 直接失败，不抛异常")
    void emptySignatureFails() {
        assertThat(HisSignature.verify(SECRET, METHOD, PATH, TS, NONCE, BODY, null)).isFalse();
        assertThat(HisSignature.verify(SECRET, METHOD, PATH, TS, NONCE, BODY, "")).isFalse();
        assertThat(HisSignature.verify(SECRET, METHOD, PATH, TS, NONCE, BODY, "   ")).isFalse();
    }

    /* ============================ 时间窗 ============================ */

    @Test
    @DisplayName("时间戳在 ±5 分钟内接受")
    void timestampWithinWindow() {
        long now = 1_763_200_000L;
        assertThat(HisSignature.timestampAcceptable(now, now)).isTrue();
        assertThat(HisSignature.timestampAcceptable(now - 299, now)).isTrue();
        assertThat(HisSignature.timestampAcceptable(now + 299, now)).isTrue();
        assertThat(HisSignature.timestampAcceptable(now - 300, now)).isTrue();
    }

    @Test
    @DisplayName("超出时间窗拒绝（防重放）")
    void timestampOutOfWindow() {
        long now = 1_763_200_000L;
        assertThat(HisSignature.timestampAcceptable(now - 301, now)).isFalse();
        assertThat(HisSignature.timestampAcceptable(now + 301, now)).isFalse();
        // 一天前的请求（典型的重放攻击）
        assertThat(HisSignature.timestampAcceptable(now - 86_400, now)).isFalse();
    }

    /* ============================ body 归一 ============================ */

    @Test
    @DisplayName("body 为 null 与空串等价")
    void nullBodyEqualsEmpty() {
        assertThat(HisSignature.sign(SECRET, METHOD, PATH, TS, NONCE, null))
                .isEqualTo(HisSignature.sign(SECRET, METHOD, PATH, TS, NONCE, ""));
    }

    @Test
    @DisplayName("body 相差一个空格也算不同签名")
    void whitespaceMatters() {
        assertThat(HisSignature.sign(SECRET, METHOD, PATH, TS, NONCE, "{}"))
                .isNotEqualTo(HisSignature.sign(SECRET, METHOD, PATH, TS, NONCE, "{ }"));
    }
}
