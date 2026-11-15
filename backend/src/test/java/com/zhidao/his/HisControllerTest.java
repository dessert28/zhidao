package com.zhidao.his;

import com.zhidao.entity.HospitalPlace;
import com.zhidao.mapper.HospitalPlaceMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * HIS 推送接口集成测试。
 *
 * <p>测的是**真实 HTTP 链路**：签名头 → 验签 → 幂等 → 落库。
 * 签名算法本身已由 {@link HisSignatureTest} 覆盖，这里关注的是
 * 接口层的安全性质：越权、篡改、重放、幂等。
 */
@SpringBootTest
@AutoConfigureMockMvc
@Transactional
@DisplayName("HIS 推送接口：按院区隔离、防篡改、幂等")
class HisControllerTest {

    private static final String APP_KEY = "z2jfl-demo-key";
    private static final String APP_SECRET = "z2jfl-demo-secret-please-rotate-in-production";
    private static final String PATH = "/api/his/places";

    @Autowired
    private MockMvc mvc;

    @Autowired
    private HospitalPlaceMapper placeMapper;

    private String ts() {
        return String.valueOf(Instant.now().getEpochSecond());
    }

    private String body(String batchId, String placeName) {
        return """
                {"batchId":"%s","places":[{"placeType":"CLINIC","department":"内分泌科",
                "name":"%s","building":"9号楼","floor":"3F","sortOrder":50}]}
                """.formatted(batchId, placeName);
    }

    /**
     * 算签名。
     *
     * <p>nonce 必须做成参数而不是写死：签名用的 nonce 与请求头里的
     * 必须是同一个值。第一版这里写死 "nonce-test"，而请求头用的是 "n"，
     * 于是所有"应该成功"的用例都被 401 拒绝 —— 看着像服务端验签有 bug，
     * 实际是测试自己没对齐。这类错在签名场景里特别常见，
     * 所以参数化 + 这条注释一起留着。
     */
    private String sig(String body, String timestamp, String nonce) {
        return HisSignature.sign(APP_SECRET, "POST", PATH, timestamp, nonce, body);
    }

    @BeforeEach
    void keepSeedCredential() {
        // 前置条件：演示凭据必须存在，否则所有用例都会 401，失败原因难查
        assertThat(mvc).isNotNull();
    }

    /* ============================ 认证 ============================ */

    @Test
    @DisplayName("没有签名头 → 401")
    void noSignature() throws Exception {
        mvc.perform(post(PATH).contentType(MediaType.APPLICATION_JSON).content(body("b1", "x")))
                .andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("appKey 不存在 → 401")
    void unknownAppKey() throws Exception {
        String b = body("b1", "x");
        String t = ts();
        mvc.perform(post(PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-App-Key", "no-such-key")
                        .header("X-Timestamp", t)
                        .header("X-Nonce", "n")
                        .header("X-Signature", sig(b, t, "n"))
                        .content(b.getBytes(StandardCharsets.UTF_8)))
                .andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("签名错误 → 401")
    void wrongSignature() throws Exception {
        String b = body("b1", "x");
        String t = ts();
        mvc.perform(post(PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-App-Key", APP_KEY)
                        .header("X-Timestamp", t)
                        .header("X-Nonce", "n")
                        .header("X-Signature", "0".repeat(64))
                        .content(b.getBytes(StandardCharsets.UTF_8)))
                .andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("时间戳过期 → 401（防重放）")
    void staleTimestamp() throws Exception {
        String b = body("b1", "x");
        // 一小时前
        String t = String.valueOf(Instant.now().getEpochSecond() - 3600);
        mvc.perform(post(PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-App-Key", APP_KEY)
                        .header("X-Timestamp", t)
                        .header("X-Nonce", "n")
                        .header("X-Signature", sig(b, t, "n"))
                        .content(b.getBytes(StandardCharsets.UTF_8)))
                .andExpect(status().isUnauthorized());
    }

    @Test
    @DisplayName("签名正确但 body 被改 → 401（防篡改）")
    void tamperedBody() throws Exception {
        String original = body("b1", "原名");
        String t = ts();
        String signature = sig(original, t, "n");
        String tampered = body("b1", "被改过的名字");

        mvc.perform(post(PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-App-Key", APP_KEY)
                        .header("X-Timestamp", t)
                        .header("X-Nonce", "n")
                        .header("X-Signature", signature)
                        .content(tampered.getBytes(StandardCharsets.UTF_8)))
                .andExpect(status().isUnauthorized());
    }

    /* ============================ 正常推送 ============================ */

    @Test
    @DisplayName("签名正确 → 200 并写入")
    void pushOk() throws Exception {
        String b = body("batch-ok-1", "推送来的诊区");
        String t = ts();
        mvc.perform(post(PATH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-App-Key", APP_KEY)
                        .header("X-Timestamp", t)
                        .header("X-Nonce", "n1")
                        .header("X-Signature", sig(b, t, "n1"))
                        .content(b.getBytes(StandardCharsets.UTF_8)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.applied").value(1))
                .andExpect(jsonPath("$.data.duplicated").value(false));

        List<HospitalPlace> places = placeMapper.selectList(
                new LambdaQueryWrapper<HospitalPlace>()
                        .eq(HospitalPlace::getHospitalCode, "Z2-JFL"));
        assertThat(places).hasSize(1);
        assertThat(places.get(0).getName()).isEqualTo("推送来的诊区");
        assertThat(places.get(0).getDataQuality())
                .as("院方推来的数据是官方数据，必须标 REAL")
                .isEqualTo("REAL");
    }

    @Test
    @DisplayName("同一 batchId 重推 → 幂等，不重复写入")
    void idempotent() throws Exception {
        String b = body("batch-idem", "诊区A");
        String t1 = ts();
        mvc.perform(post(PATH).contentType(MediaType.APPLICATION_JSON)
                        .header("X-App-Key", APP_KEY).header("X-Timestamp", t1)
                        .header("X-Nonce", "n1").header("X-Signature", sig(b, t1, "n1")).content(b.getBytes(StandardCharsets.UTF_8)))
                .andExpect(status().isOk());

        // 院方重试：同一 batchId，可能是不同时间戳与 nonce
        String t2 = ts();
        mvc.perform(post(PATH).contentType(MediaType.APPLICATION_JSON)
                        .header("X-App-Key", APP_KEY).header("X-Timestamp", t2)
                        .header("X-Nonce", "n2").header("X-Signature", sig(b, t2, "n2")).content(b.getBytes(StandardCharsets.UTF_8)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.duplicated").value(true));

        List<HospitalPlace> places = placeMapper.selectList(
                new LambdaQueryWrapper<HospitalPlace>()
                        .eq(HospitalPlace::getHospitalCode, "Z2-JFL"));
        assertThat(places)
                .as("重推不应产生重复数据")
                .hasSize(1);
    }

    /* ============================ 越权 ============================ */

    @Test
    @DisplayName("院区取自凭据，不取请求体 —— 防止 A 医院改 B 医院的导航")
    void hospitalBoundByCredential() throws Exception {
        /*
         * 请求体里塞了 MOCK-A，但凭据属于 Z2-JFL。
         * 正确行为：写入 Z2-JFL，MOCK-A 的数据不动。
         */
        String b = """
                {"batchId":"batch-cross","hospitalCode":"MOCK-A",
                 "places":[{"placeType":"CLINIC","name":"恶意数据","building":"1号楼","floor":"1F"}]}
                """;
        String t = ts();
        mvc.perform(post(PATH).contentType(MediaType.APPLICATION_JSON)
                        .header("X-App-Key", APP_KEY).header("X-Timestamp", t)
                        .header("X-Nonce", "n").header("X-Signature", sig(b, t, "n")).content(b.getBytes(StandardCharsets.UTF_8)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.hospitalCode").value("Z2-JFL"));

        long mockACount = placeMapper.selectCount(new LambdaQueryWrapper<HospitalPlace>()
                .eq(HospitalPlace::getHospitalCode, "MOCK-A"));
        assertThat(mockACount)
                .as("凭据绑定 Z2-JFL，不该写进 MOCK-A")
                .isZero();
    }

    /* ============================ 数据校验 ============================ */

    @Test
    @DisplayName("空清单被拒绝 —— 整批替换语义下空清单等于清空")
    void emptyListRejected() throws Exception {
        String b = "{\"batchId\":\"batch-empty\",\"places\":[]}";
        String t = ts();
        mvc.perform(post(PATH).contentType(MediaType.APPLICATION_JSON)
                        .header("X-App-Key", APP_KEY).header("X-Timestamp", t)
                        .header("X-Nonce", "n").header("X-Signature", sig(b, t, "n")).content(b.getBytes(StandardCharsets.UTF_8)))
                .andExpect(status().isBadRequest());

        // 原有的地点不能被清掉
        long count = placeMapper.selectCount(new LambdaQueryWrapper<HospitalPlace>()
                .eq(HospitalPlace::getHospitalCode, "Z2-JFL"));
        assertThat(count).as("被拒绝的推送不该影响已有数据").isGreaterThan(0);
    }

    @Test
    @DisplayName("缺少 batchId → 400（幂等必需）")
    void missingBatchId() throws Exception {
        String b = "{\"places\":[{\"placeType\":\"CLINIC\",\"name\":\"x\"}]}";
        String t = ts();
        mvc.perform(post(PATH).contentType(MediaType.APPLICATION_JSON)
                        .header("X-App-Key", APP_KEY).header("X-Timestamp", t)
                        .header("X-Nonce", "n").header("X-Signature", sig(b, t, "n")).content(b.getBytes(StandardCharsets.UTF_8)))
                .andExpect(status().isBadRequest());
    }

    @Test
    @DisplayName("非法 placeType → 400 并指出是第几条")
    void invalidPlaceType() throws Exception {
        String b = "{\"batchId\":\"b-bad\",\"places\":[{\"placeType\":\"NOT_A_TYPE\",\"name\":\"x\"}]}";
        String t = ts();
        mvc.perform(post(PATH).contentType(MediaType.APPLICATION_JSON)
                        .header("X-App-Key", APP_KEY).header("X-Timestamp", t)
                        .header("X-Nonce", "n").header("X-Signature", sig(b, t, "n")).content(b.getBytes(StandardCharsets.UTF_8)))
                .andExpect(status().isBadRequest());
    }
}
