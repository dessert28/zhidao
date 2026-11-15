package com.zhidao.his;

import com.zhidao.common.ApiResult;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * HIS 对接接口 —— 院方把自己的官方数据推给我们。
 *
 * <h3>与其它接口的根本区别</h3>
 *
 * <p>其余接口都是"患者 / 前端在调"，靠 JWT 识别用户。
 * 这一组是**院方服务器在调**，靠 appKey + HMAC 签名识别机构。
 * 所以它不经过 JWT 过滤器，也不该出现在患者端的任何调用里。
 *
 * <h3>路径前缀</h3>
 *
 * <p>用 {@code /api/his/} 而不是塞进现有的 /api/bookings 之类：
 * 院方接入是一个独立的对外契约，将来可能单独限流、单独审计、
 * 甚至单独部署（比如放到 DMZ）。前缀分开便于这些演进。
 *
 * <h3>调试支持</h3>
 *
 * <p>院方接入最痛的是"签名算不对但不告诉哪里不对"。
 * 所以提供一个 {@code /api/his/sign} 辅助接口：院方把自己的参数发来，
 * 我们用他的 secret 算出签名并返回，他对比自己的实现就能定位。
 * <b>这个接口需要验签才能调</b> —— 否则等于把 secret 验签服务开放给任何人。
 */
@Slf4j
@RestController
@RequestMapping("/api/his")
@RequiredArgsConstructor
public class HisController {

    private final HisIngestService ingest;

    /* ============================ 推送院内地点 ============================ */

    /**
     * 院方推送院内地点（科室楼层、窗口、药房位置等）。
     *
     * <p><b>整批替换语义</b>：每次推送必须是该院区的**完整清单**，
     * 我们会清掉旧地点再写入新的。分批推送会导致前一批被覆盖。
     */
    @PostMapping("/places")
    public ResponseEntity<?> pushPlaces(
            @RequestHeader(value = "X-App-Key", required = false) String appKey,
            @RequestHeader(value = "X-Timestamp", required = false) String timestamp,
            @RequestHeader(value = "X-Nonce", required = false) String nonce,
            @RequestHeader(value = "X-Signature", required = false) String signature,
            @RequestBody(required = false) String rawBody,
            HttpServletRequest request) {

        String path = "/api/his/places";
        var auth = ingest.authenticate(appKey, signature, timestamp, nonce,
                "POST", path, rawBody == null ? "" : rawBody);
        if (!auth.ok()) {
            return unauthorized(auth.reason());
        }

        PlacePushBody body;
        try {
            body = parse(rawBody);
        } catch (RuntimeException e) {
            return badRequest("请求体解析失败：" + e.getMessage());
        }

        /*
         * 院区取自**凭据绑定**，不取请求体里的 hospitalCode。
         * 这是防越权的关键：A 医院的凭据即使传了 B 医院的编码，
         * 也只能写 A 自己的数据。
         */
        String hospitalCode = auth.credential().getHospitalCode();

        if (body.batchId() == null || body.batchId().isBlank()) {
            return badRequest("缺少 batchId（幂等必需）");
        }

        HisIngestService.IngestResult r =
                ingest.pushPlaces(hospitalCode, body.batchId(), body.places());

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("hospitalCode", hospitalCode);
        data.put("batchId", body.batchId());
        data.put("duplicated", r.duplicated());
        data.put("applied", r.applied());
        data.put("message", r.message());
        if (!r.ok()) {
            return ResponseEntity.badRequest().body(ApiResult.fail(40000, r.message()));
        }
        return ResponseEntity.ok(ApiResult.ok(data));
    }

    /* ============================ 签名自检 ============================ */

    /**
     * 签名自检 —— 帮院方定位"我的签名为什么算不对"。
     *
     * <p>请求体给 {@code {method, path, timestamp, nonce, body}}，
     * 返回我们算出来的签名。院方用自己的实现算一遍对比即可。
     *
     * <p>需要验签才能调用：否则任何人拿到 appKey 就能用它算签名，
     * 等于把 secret 当公开密钥用。
     */
    @PostMapping("/sign")
    public ResponseEntity<?> signHelper(
            @RequestHeader(value = "X-App-Key", required = false) String appKey,
            @RequestHeader(value = "X-Timestamp", required = false) String timestamp,
            @RequestHeader(value = "X-Nonce", required = false) String nonce,
            @RequestHeader(value = "X-Signature", required = false) String signature,
            @RequestBody(required = false) String rawBody,
            HttpServletRequest request) {

        var auth = ingest.authenticate(appKey, signature, timestamp, nonce,
                "POST", "/api/his/sign", rawBody == null ? "" : rawBody);
        if (!auth.ok()) {
            return unauthorized(auth.reason());
        }

        String secret = auth.credential().getAppSecret();
        Map<String, Object> data = new LinkedHashMap<>();
        /*
         * 把签名串拼法也返回，院方对照就能看出是自己拼错了还是密钥用错了。
         * 注意**不返回 secret 本身**。
         */
        data.put("algorithm", "HMAC-SHA256");
        data.put("stringToSign",
                "METHOD\\nPATH\\nTIMESTAMP\\nNONCE\\nSHA256(body)");
        data.put("example", "POST\n/api/his/places\n" + timestamp + "\n" + nonce
                + "\n<sha256 of body>");
        data.put("yourSignature", HisSignature.sign(secret, "POST", "/api/his/sign",
                timestamp, nonce, rawBody == null ? "" : rawBody));
        data.put("hint", "用同样的 method/path/timestamp/nonce/body 重算一次，"
                + "结果应与 yourSignature 完全一致（小写十六进制）");
        return ResponseEntity.ok(ApiResult.ok(data));
    }

    /* ============================ 辅助 ============================ */

    /** 推送请求体。用 record 而不是嵌套 Map，字段名有编译期约束 */
    public record PlacePushBody(
            String batchId,
            /* 院方可以带上自己的院区编码，但我们只用来核对，不用来写入 */
            String hospitalCode,
            List<HisIngestService.PlaceItem> places
    ) {
    }

    private PlacePushBody parse(String rawBody) {
        if (rawBody == null || rawBody.isBlank()) {
            throw new IllegalArgumentException("body 为空");
        }
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper()
                    .readerFor(PlacePushBody.class)
                    .readValue(rawBody.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IllegalArgumentException(e.getMessage());
        }
    }

    private ResponseEntity<?> unauthorized(String reason) {
        /*
         * 统一返回 401 而不是 403：院方接入只关心"我能不能调"，
         * 不需要区分"没带凭据"和"凭据不对"—— 后者反而给了攻击者信息。
         * 但 reason 里保留可诊断的信息（不包含 secret）。
         */
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(ApiResult.fail(40100, reason));
    }

    private ResponseEntity<?> badRequest(String msg) {
        return ResponseEntity.badRequest().body(ApiResult.fail(40000, msg));
    }
}
