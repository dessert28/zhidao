package com.zhidao;

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
 * 两组「已预留、待开发」接口的契约测试。
 *
 * <p>这些用例锁住的不是业务逻辑（那还不存在），而是<b>状态码的诚实性</b>：
 * <ul>
 *   <li>医生端摘要必须是 501 + 50101，<b>不能是 200 + 空 data</b>。
 *       200 会被前端/网关当成「接口可用」，把一个待开发项拖到演示现场才炸。</li>
 *   <li>知识库三端点必须先过权限：未登录 401，普通患者 403。
 *       放行规则一旦被改成 {@code authenticated()} 或 {@code permitAll()}，
 *       这两条就会红 —— 这是刻意的：写权限的边界只能收紧，不能靠「反正返回 501」放宽。</li>
 * </ul>
 *
 * <p>登录方式沿用 {@link ApiIntegrationTest}：种子账号 demo/demo1234 换真 token，
 * 不 mock 认证 —— mock 会把 {@code JwtAuthenticationFilter} 里
 * {@code ROLE_ + role} 这一段绕过去，而「普通账号是否会误拿到管理员权限」
 * 恰恰是这里要验证的东西。
 */
@SpringBootTest
@AutoConfigureMockMvc
class ReservedApiTest {

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper json;

    /** 种子患者账号的令牌（role=PATIENT） */
    private String patientToken;

    @BeforeEach
    void login() throws Exception {
        String body = mvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"demo\",\"password\":\"demo1234\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        patientToken = json.readTree(body).path("data").path("token").asText();
        assertThat(patientToken).as("登录必须拿到令牌，否则下面的权限断言没有意义").isNotBlank();
    }

    /* ==================== 医生端预问诊摘要（预留 50101） ==================== */

    @Test
    @DisplayName("医生端摘要：匿名凭 token 访问返回 501 + 50101（不是 200 空数据）")
    void doctorBriefIsNotImplemented() throws Exception {
        MvcResult r = mvc.perform(get("/api/doctor/brief/whatever"))
                .andExpect(status().isNotImplemented())
                .andReturn();

        String body = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        // 统一响应体：错误也要是 JSON，否则前端 res.json() 直接抛
        assertThat(r.getResponse().getContentType()).contains("application/json");
        assertThat(json.readTree(body).path("code").asInt()).isEqualTo(50101);
        assertThat(json.readTree(body).path("message").asText()).contains("已预留");
        /*
         * 待开发就不该有 data，避免前端把预留接口当成「暂时没数据」。
         *
         * 注意 application.yml 里 default-property-inclusion=non_null，
         * 所以 data 不是 null 而是整个字段被省略 —— 判断要同时接受「缺失」和「null」。
         */
        var data = json.readTree(body).path("data");
        assertThat(data.isMissingNode() || data.isNull())
                .as("预留接口不应返回 data，否则前端会渲染成空摘要")
                .isTrue();
    }

    @Test
    @DisplayName("医生端摘要：带上患者 JWT 也仍是 501，不会因为多带了令牌就返回数据")
    void doctorBriefIgnoresPatientJwt() throws Exception {
        /*
         * 这条防的是一种很自然的「顺手实现」：
         * 有人看到 permitAll，就在 controller 里回退成「有 JWT 就返回当前患者摘要」。
         * 那样医生的链接语义（一次性 token）就没了，还会让任何患者
         * 通过改 URL 里的 token 去看别人的摘要。当前必须先 501。
         */
        mvc.perform(get("/api/doctor/brief/whatever")
                        .header("Authorization", "Bearer " + patientToken))
                .andExpect(status().isNotImplemented());
    }

    /* ==================== 院方知识库运营（预留 50102） ==================== */

    @Test
    @DisplayName("知识库列表：未登录 401（放行规则没有被误改成 permitAll）")
    void knowledgeDocumentsRequiresLogin() throws Exception {
        MvcResult r = mvc.perform(get("/api/admin/knowledge/documents"))
                .andExpect(status().isUnauthorized())
                .andReturn();

        String body = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(json.readTree(body).path("code").asInt()).isEqualTo(40100);
    }

    @Test
    @DisplayName("知识库列表：普通患者账号 403（配置选了 hasRole('ADMIN')，见下方说明）")
    void knowledgeDocumentsForbiddenForPatient() throws Exception {
        /*
         * ====== 这里断言的是 403，不是 501，原因写清楚 ======
         *
         * SecurityConfig 对 /api/admin/knowledge/** 用的是 hasRole("ADMIN")，
         * 而 JwtAuthenticationFilter 把 JWT 的 role 声明转成 "ROLE_" + role，
         * 所以 demo 账号（PATIENT → ROLE_PATIENT）进不了业务层，
         * 请求在过滤器链上就被 AccessDeniedHandler 拦成 403。
         *
         * 这也是为什么 50102 目前「谁都看不到」：
         * 种子数据里没有 ADMIN 账号。这不是 bug —— 预留接口本来就是给
         * 实现阶段用的；等补了管理员账号，50102 才会成为可观测的响应。
         *
         * 反过来说，如果哪天这条变成了 200 或 501，说明权限规则被放宽了，
         * 那是必须当场拦下的回归。
         */
        MvcResult r = mvc.perform(get("/api/admin/knowledge/documents")
                        .header("Authorization", "Bearer " + patientToken))
                .andExpect(status().isForbidden())
                .andReturn();

        String body = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(json.readTree(body).path("code").asInt()).isEqualTo(40300);
    }

    @Test
    @DisplayName("知识库上传 / 重建索引：普通患者同样 403，写操作不因「待开发」而放行")
    void knowledgeWritesForbiddenForPatient() throws Exception {
        mvc.perform(post("/api/admin/knowledge/documents")
                        .header("Authorization", "Bearer " + patientToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"title\":\"测试\",\"docType\":\"NOTICE\",\"content\":\"正文\"}"))
                .andExpect(status().isForbidden());

        mvc.perform(post("/api/admin/knowledge/reindex")
                        .header("Authorization", "Bearer " + patientToken))
                .andExpect(status().isForbidden());
    }
}
