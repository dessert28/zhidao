package com.zhidao.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * AI 接入最小验证端点的契约测试。
 *
 * <p>锁住三件事，都是"将来改坏了能当场发现"的回归防线：
 * <ol>
 *   <li><b>无 Key 降级</b>：未配 ZHIDAO_LLM_API_KEY 时，端点返回
 *       {@code configured=false} 的 200，<b>不是 500/401</b>。
 *       这是"无 Key 也能完整演示"这条承诺在 AI 层的落地。</li>
 *   <li><b>可见性与 chat 一致</b>：这个端点是答辩演示用的探针，与 {@code /api/chat}
 *       同样匿名开放。不是"忘了加鉴权"——挡住 verify 而放开 chat 是假安全：
 *       真要被刷，攻击者去刷对话即可，verify 反而更便宜。
 *       公网部署时必须给整组 AI 端点统一补 IP 限流（docs/18 §7）。</li>
 *   <li><b>不泄露配置</b>：响应体里没有 apiKey/base-url 等任何配置字段。</li>
 * </ol>
 *
 * <p>登录方式沿用 {@link com.zhidao.ReservedApiTest}：真 token，不 mock 认证。
 */
@SpringBootTest
@AutoConfigureMockMvc
class AiVerificationTest {

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper json;

    private String patientToken;

    @BeforeEach
    void login() throws Exception {
        String body = mvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"demo\",\"password\":\"demo1234\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        patientToken = json.readTree(body).path("data").path("token").asText();
        assertThat(patientToken).isNotBlank();
    }

    @Test
    @DisplayName("AI 验证端点：匿名可访问（与 /api/chat 同可见性），无 Key 时给明确状态")
    void verifyIsPublicLikeChat() throws Exception {
        MvcResult r = mvc.perform(get("/api/ai/verify"))
                .andExpect(status().isOk())
                .andReturn();

        String body = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        // 测试环境没注入 Key，所以走降级分支；关键是不能是 401/500
        assertThat(json.readTree(body).path("data").path("configured").asBoolean()).isFalse();
    }

    @Test
    @DisplayName("AI 验证端点：无 Key 时返回 configured=false 的明确状态，不是错误")
    void verifyDegradesWhenNoKey() throws Exception {
        /*
         * 测试环境没有注入 ZHIDAO_LLM_API_KEY，AiVerificationConfig 里
         * "Key 非空才造 bean" 的条件不满足，Controller 应走降级分支。
         * 这里断言的是"明确的未配置状态"，而不是让它去请求然后 401/503。
         */
        MvcResult r = mvc.perform(get("/api/ai/verify")
                        .header("Authorization", "Bearer " + patientToken))
                .andExpect(status().isOk())
                .andReturn();

        String body = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        var data = json.readTree(body).path("data");
        assertThat(data.path("configured").asBoolean()).isFalse();
        assertThat(data.path("message").asText()).contains("未配置");
    }

    @Test
    @DisplayName("AI 验证端点：响应体不含 apiKey / base-url 等任何配置字段")
    void verifyNeverLeaksConfig() throws Exception {
        String body = mvc.perform(get("/api/ai/verify")
                        .header("Authorization", "Bearer " + patientToken))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        // Key、网关地址都属于配置秘密，出现任何一个字段都是泄露
        assertThat(body).doesNotContain("apiKey", "api-key", "base-url", "baseUrl", "api_key");
    }
}
