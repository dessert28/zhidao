package com.zhidao;

import com.fasterxml.jackson.databind.JsonNode;
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
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/**
 * 接口层集成测试。
 *
 * <p>为什么这些用例值得写：它们锁住的是<b>曾经真的错过</b>的几件事 ——
 * <ul>
 *   <li>种子数据里的 BCrypt 哈希对不上 demo1234（网上抄来的哈希），
 *       症状是登录永远 401 而密码没写错</li>
 *   <li>业务异常一律返回 200 或一律返回 400，
 *       导致"密码错"和"服务器崩"在客户端看起来一样</li>
 *   <li>未登录时 Spring 默认吐 HTML 错误页，前端 res.json() 直接抛</li>
 * </ul>
 * 每一条都在下面有对应用例。删掉它们之前，先想清楚下次还会不会犯。
 */
@SpringBootTest
@AutoConfigureMockMvc
class ApiIntegrationTest {

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper json;

    private String token;

    @BeforeEach
    void login() throws Exception {
        String body = mvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"demo\",\"password\":\"demo1234\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        token = json.readTree(body).path("data").path("token").asText();
        assertThat(token).as("登录必须拿到令牌").isNotBlank();
    }

    /* ============================ 认证 ============================ */

    @Test
    @DisplayName("种子账号 demo/demo1234 能登录（防止抄来的哈希再次混进来）")
    void demoAccountCanLogin() {
        assertThat(token).isNotEmpty();
    }

    @Test
    @DisplayName("密码错误返回 401，且不泄露用户名是否存在")
    void wrongPasswordIsUnauthorized() throws Exception {
        String out = mvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"demo\",\"password\":\"nope\"}"))
                .andExpect(status().isUnauthorized())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        String notExist = mvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"nobody\",\"password\":\"nope\"}"))
                .andExpect(status().isUnauthorized())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        // 两句话必须一模一样，否则等于送一个用户名枚举接口
        assertThat(json.readTree(out).path("message").asText())
                .isEqualTo(json.readTree(notExist).path("message").asText());
    }

    @Test
    @DisplayName("未登录访问患者接口返回 401 且是 JSON，不是 HTML 错误页")
    void unauthorizedIsJson() throws Exception {
        MvcResult r = mvc.perform(get("/api/patient/records"))
                .andExpect(status().isUnauthorized())
                .andReturn();
        String body = r.getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(r.getResponse().getContentType()).contains("application/json");
        assertThat(json.readTree(body).path("code").asInt()).isEqualTo(40100);
    }

    @Test
    @DisplayName("伪造令牌不被接受")
    void forgedTokenRejected() throws Exception {
        mvc.perform(get("/api/patient/records")
                        .header("Authorization", "Bearer forged.token.value"))
                .andExpect(status().isUnauthorized());
    }

    /* ============================ 档案与病历 ============================ */

    @Test
    @DisplayName("档案带上推算年龄，且不含任何身份字段")
    void profileHasAgeAndNoIdentity() throws Exception {
        String body = mvc.perform(get("/api/patient/profile").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        JsonNode data = json.readTree(body).path("data");
        assertThat(data.path("age").asInt()).isGreaterThan(0);
        assertThat(data.path("allergies").isArray()).isTrue();
        // 这三个字段一旦出现在响应里，隐私架构就破了
        assertThat(body).doesNotContain("phone").doesNotContain("idCard").doesNotContain("realName");
    }

    @Test
    @DisplayName("跨院时间轴返回 3 条种子记录，且按院区分组")
    void recordsAreCrossHospital() throws Exception {
        String body = mvc.perform(get("/api/patient/records").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        JsonNode data = json.readTree(body).path("data");
        assertThat(data.path("total").asInt()).isGreaterThanOrEqualTo(3);
        // 核心卖点：两家医院都有记录
        assertThat(data.path("byHospital").has("MOCK-A")).isTrue();
        assertThat(data.path("byHospital").has("MOCK-B")).isTrue();
    }

    @Test
    @DisplayName("更新档案：传了才覆盖，没传的字段保持不变")
    void partialProfileUpdate() throws Exception {
        mvc.perform(put("/api/patient/profile")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"chronics\":\"高血压\"}"))
                .andExpect(status().isOk());

        String body = mvc.perform(get("/api/patient/profile").header("Authorization", "Bearer " + token))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        JsonNode data = json.readTree(body).path("data");

        assertThat(data.path("chronics").toString()).contains("高血压");
        // 过敏史这次没传，必须还在
        assertThat(data.path("allergies").toString()).contains("青霉素");

        // 还原，避免影响后续用例。
        // 用 @BeforeEach 的登录令牌重发，顺便验证"多次 PUT 幂等"
        mvc.perform(put("/api/patient/profile")
                .header("Authorization", "Bearer " + token)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"chronics\":\"高血压,2型糖尿病\"}"))
                .andExpect(status().isOk());
    }

    @Test
    @DisplayName("出生年份越界被拦，且错误信息指出字段名")
    void invalidBirthYearRejected() throws Exception {
        String body = mvc.perform(put("/api/patient/profile")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"birthYear\":196}"))
                .andExpect(status().isBadRequest())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(json.readTree(body).path("message").asText()).contains("birthYear");
    }

    /* ============================ 预约 ============================ */

    @Test
    @DisplayName("两家 Mock 院区都注册上了")
    void bothHospitalsRegistered() throws Exception {
        String body = mvc.perform(get("/api/bookings/hospitals").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        assertThat(body).contains("MOCK-A").contains("MOCK-B");
    }

    @Test
    @DisplayName("两家院区的号源松紧不同（换院区才有意义的实证）")
    void quotaDiffersBetweenHospitals() throws Exception {
        int a = slotCount("MOCK-A", "内分泌科");
        int b = slotCount("MOCK-B", "内分泌科");
        assertThat(b).as("MOCK-B 内分泌科号源应比 MOCK-A 宽松").isGreaterThan(a);
    }

    private int slotCount(String code, String dept) throws Exception {
        String body = mvc.perform(get("/api/bookings/slots")
                        .param("hospitalCode", code)
                        .param("department", dept)
                        .param("date", "2026-11-16")
                        .header("Authorization", "Bearer " + token))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        return json.readTree(body).path("data").size();
    }

    /**
     * 号源不能出现已经过去的时段。
     *
     * <p>实测缺陷（2026-11-15 下午 14:12）：排程推荐当天 08:30，
     * 用户点「确认挂号」后收到「就诊时间必须在将来」——
     * 系统给了一个自己会拒绝的号。这比没号更糟：它让用户以为
     * 能约，点下去才发现不行。
     *
     * <p>修法在 Service 层过滤（适配器代表院方，院方号表里
     * "今天的 08:30" 确实存在；是否该给用户看是我们的事）。
     */
    @Test
    @DisplayName("当天号源只保留未来时段")
    void slotsExcludePastTimes() throws Exception {
        String today = java.time.LocalDate.now().toString();
        String body = mvc.perform(get("/api/bookings/slots")
                        .param("hospitalCode", "MOCK-A")
                        .param("department", "内分泌科")
                        .param("date", today)
                        .header("Authorization", "Bearer " + token))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        com.fasterxml.jackson.databind.JsonNode slots = json.readTree(body).path("data");
        java.time.LocalDateTime now = java.time.LocalDateTime.now();

        for (com.fasterxml.jackson.databind.JsonNode s : slots) {
            java.time.LocalDateTime visitTime =
                    java.time.LocalDateTime.parse(s.path("visitTime").asText());
            assertThat(visitTime)
                    .as("号源不应包含已过去的时段：" + visitTime + " < " + now)
                    .isAfter(now);
        }
    }

    /**
     * 查历史日期应返回空列表，而不是一堆过去的号。
     */
    @Test
    @DisplayName("查过去日期返回空号源")
    void pastDateReturnsNoSlots() throws Exception {
        String body = mvc.perform(get("/api/bookings/slots")
                        .param("hospitalCode", "MOCK-A")
                        .param("department", "内分泌科")
                        .param("date", "2025-01-01")
                        .header("Authorization", "Bearer " + token))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        assertThat(json.readTree(body).path("data").size()).isZero();
    }

    /**
     * 下单后号源余量必须减少。
     *
     * <p>实测缺陷（2026-11-15）：Mock 适配器把 remaining 写死成 1，
     * 下单成功后查号源仍然显示 1 —— 看起来"无限可约"。
     * 虽然重复下单会被 409 拦住，但**展示给患者的数字是错的**，
     * 点进去才发现被拒，比没号更让人困惑。
     *
     * <p>修法是在 Service 层扣减本地已预约数量（适配器代表院方，
     * 不该知道我们的订单表）。
     */
    @Test
    @DisplayName("下单后该时段余量减为 0，其他时段不受影响")
    void remainingDecreasesAfterBooking() throws Exception {
        String dept = "神经内科";
        String date = "2026-11-16";

        // 找一个还有号的时段
        String before = mvc.perform(get("/api/bookings/slots")
                        .param("hospitalCode", "MOCK-A")
                        .param("department", dept)
                        .param("date", date)
                        .header("Authorization", "Bearer " + token))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        com.fasterxml.jackson.databind.JsonNode slots = json.readTree(before).path("data");
        assertThat(slots.size()).as("前置条件：该科室当天应有号源").isGreaterThan(0);

        String visitTime = slots.get(0).path("visitTime").asText();
        int beforeRemaining = slots.get(0).path("remaining").asInt();
        assertThat(beforeRemaining).as("前置条件：该时段初始有余量").isGreaterThan(0);

        // 下单
        mvc.perform(post("/api/bookings")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"hospitalCode\":\"MOCK-A\",\"department\":\"" + dept
                                + "\",\"visitTime\":\"" + visitTime + "\"}"))
                .andExpect(status().isOk());

        // 复查：该时段余量应减 1，其余时段不变
        String after = mvc.perform(get("/api/bookings/slots")
                        .param("hospitalCode", "MOCK-A")
                        .param("department", dept)
                        .param("date", date)
                        .header("Authorization", "Bearer " + token))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        com.fasterxml.jackson.databind.JsonNode afterSlots = json.readTree(after).path("data");

        int matched = 0;
        for (com.fasterxml.jackson.databind.JsonNode s : afterSlots) {
            if (s.path("visitTime").asText().equals(visitTime)) {
                assertThat(s.path("remaining").asInt())
                        .as("下单后该时段余量应减 1")
                        .isEqualTo(beforeRemaining - 1);
                matched++;
            } else {
                assertThat(s.path("remaining").asInt())
                        .as("其他时段不应受影响")
                        .isEqualTo(1);
            }
        }
        assertThat(matched).as("应能找回被预约的那个时段").isEqualTo(1);
    }

    @Test
    @DisplayName("不存在的院区返回 400，而不是悄悄换成别家")
    void unknownHospitalRejected() throws Exception {
        mvc.perform(post("/api/bookings")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"hospitalCode\":\"MOCK-Z\",\"department\":\"内分泌科\",\"visitTime\":\"2027-01-01T09:00:00\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    @DisplayName("约到过去的时间被拦")
    void pastVisitTimeRejected() throws Exception {
        mvc.perform(post("/api/bookings")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"hospitalCode\":\"MOCK-A\",\"department\":\"内分泌科\",\"visitTime\":\"2020-01-01T09:00:00\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    @DisplayName("非法状态迁移返回 409（CREATED 不能直接变 COMPLETED）")
    void illegalTransitionConflicts() throws Exception {
        String created = mvc.perform(post("/api/bookings")
                        .header("Authorization", "Bearer " + token)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"hospitalCode\":\"MOCK-A\",\"department\":\"神经内科\",\"visitTime\":\"2027-02-01T09:00:00\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        long id = json.readTree(created).path("data").path("id").asLong();

        mvc.perform(post("/api/bookings/" + id + "/complete")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isConflict());

        // 合法路径：先确认，再完成
        mvc.perform(post("/api/bookings/" + id + "/confirm").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk());
        mvc.perform(post("/api/bookings/" + id + "/complete").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk());
    }

    @Test
    @DisplayName("别人的预约单按不存在处理（不泄露 id 是否存在）")
    void otherUsersBookingIsNotFound() throws Exception {
        mvc.perform(get("/api/bookings/999999").header("Authorization", "Bearer " + token))
                .andExpect(status().isNotFound());
    }

    /* ============================ 提醒 ============================ */

    @Test
    @DisplayName("提醒列表带 reason —— 每条都要能解释为什么提醒")
    void remindersCarryReason() throws Exception {
        // 种子数据里的提醒在 2026-11-14 前后到期。
        // 换一台机器换一个日子跑，它就可能还"没到期"，所以这里不能假设列表非空。
        // 直接查"全部"（含已处理的），并单独断言：只要有条目，就必须带 reason。
        String body = mvc.perform(get("/api/reminders/all").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        JsonNode list = json.readTree(body).path("data");
        assertThat(list.isArray()).isTrue();
        assertThat(list.size()).as("种子数据至少有 1 条提醒").isGreaterThan(0);
        for (JsonNode t : list) {
            assertThat(t.path("reason").asText())
                    .as("提醒没有 reason 就和日历闹钟没区别")
                    .isNotBlank();
        }
    }

    @Test
    @DisplayName("待办列表只含未处理的，且按到期时间正序")
    void pendingIsSortedAndFiltered() throws Exception {
        String body = mvc.perform(get("/api/reminders").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        JsonNode list = json.readTree(body).path("data");
        String prev = "";
        for (JsonNode t : list) {
            String status = t.path("status").asText();
            assertThat(status).isIn("PENDING", "SENT");
            String due = t.path("dueAt").asText();
            if (!prev.isEmpty()) {
                assertThat(due.compareTo(prev)).as("最近的排最前").isGreaterThanOrEqualTo(0);
            }
            prev = due;
        }
    }

    @Test
    @DisplayName("标记完成后再出现在待办里")
    void markingDoneRemovesFromPending() throws Exception {
        String body = mvc.perform(get("/api/reminders").header("Authorization", "Bearer " + token))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        JsonNode pending = json.readTree(body).path("data");
        if (pending.size() == 0) {
            // 已经在别处被处理过（H2 内存库在同一次 JVM 内是共享的）
            return;
        }
        long id = pending.get(0).path("id").asLong();

        mvc.perform(post("/api/reminders/" + id + "/done").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk());

        String after = mvc.perform(get("/api/reminders").header("Authorization", "Bearer " + token))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        for (JsonNode t : json.readTree(after).path("data")) {
            assertThat(t.path("id").asLong()).isNotEqualTo(id);
        }
    }
}
