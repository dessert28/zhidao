package com.zhidao.his;

import com.zhidao.common.ApiResult;
import com.zhidao.entity.AccessAudit;
import com.zhidao.entity.MedicalRecord;
import com.zhidao.entity.PatientBinding;
import com.zhidao.security.CurrentUser;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 院方调阅接口 —— 就诊即授权。
 *
 * <h3>与 /api/his/places 的关系</h3>
 *
 * <p>同一个 /api/his 前缀、同一套 appKey + HMAC 认证：
 * 对院方来说只有「一个集成点」，不必学两套签名。
 * 区别在方向 —— places 是院方推给我们，这里是院方从我们拉。
 *
 * <h3>为什么按「就诊日期」而不是「visitId」</h3>
 *
 * <p>最严谨的做法是 HIS 传真实就诊流水号、我方反查。但那要求
 * 挂号系统与病案系统互通，多数医院做不到，落地成本高。
 * 改用「匹配码 + 就诊日期 + 30 天窗口」：
 * 院方只需知道患者在我方的匹配码，其余我们自己算。
 *
 * <p>代价必须说清：这等于把「是不是一次真实就诊」的判定，
 * 部分让渡给了院方诚信。缓解手段是院区 appKey 隔离 + 全量审计 ——
 * 某院区若出现异常调阅量，日志上一眼能看出来。
 */
@RestController
@RequestMapping("/api/his")
@RequiredArgsConstructor
public class AccessController {

    private final HisIngestService ingest;
    private final AccessGrantService grants;

    /* ============================ 院方调阅 ============================ */

    /** 调阅请求体 */
    public record AccessBody(String matchCode, String visitDate) {
    }

    /**
     * 院方调阅患者在本次就诊窗口内的报告。
     *
     * <p>GET 带 body 不常见，但这里需要同时传匹配码与就诊日期，
     * 用 POST 更稳妥；签名算法对 POST 的支持也更完整。
     */
    @PostMapping("/patient-report")
    public ResponseEntity<?> patientReport(
            @RequestHeader(value = "X-App-Key", required = false) String appKey,
            @RequestHeader(value = "X-Timestamp", required = false) String timestamp,
            @RequestHeader(value = "X-Nonce", required = false) String nonce,
            @RequestHeader(value = "X-Signature", required = false) String signature,
            @RequestBody(required = false) String rawBody,
            HttpServletRequest request) {

        String path = "/api/his/patient-report";
        var auth = ingest.authenticate(appKey, signature, timestamp, nonce,
                "POST", path, rawBody == null ? "" : rawBody);
        if (!auth.ok()) {
            return unauthorized(auth.reason());
        }

        AccessBody body;
        try {
            body = new com.fasterxml.jackson.databind.ObjectMapper()
                    .readValue(rawBody == null ? "{}" : rawBody, AccessBody.class);
        } catch (Exception e) {
            return badRequest("请求体解析失败：" + e.getMessage());
        }

        LocalDate visitDate = null;
        if (body.visitDate() != null && !body.visitDate().isBlank()) {
            try {
                visitDate = LocalDate.parse(body.visitDate());
            } catch (Exception e) {
                return badRequest("visitDate 格式应为 YYYY-MM-DD");
            }
        }

        // 院区取自凭据，不取请求体 —— 与 places 一致，防越权
        String hospitalCode = auth.credential().getHospitalCode();
        String ip = clientIp(request);

        var r = grants.accessForVisit(hospitalCode, appKey, body.matchCode(), visitDate, ip);
        if (!r.ok()) {
            /*
             * 拒绝也记审计。患者有权知道「有医院试图查阅但被拒绝了」——
             * 这恰恰是最需要让患者看到的记录。
             */
            grants.recordAudit(0, hospitalCode, appKey, "DENIED", visitDate, List.of(), ip);
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(ApiResult.fail(40300, r.reason()));
        }

        List<Long> ids = new ArrayList<>();
        List<Map<String, Object>> out = new ArrayList<>();
        for (MedicalRecord m : r.records()) {
            ids.add(m.getId());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("recordId", m.getId());
            row.put("visitDate", m.getVisitDate().toString());
            row.put("hospitalCode", m.getHospitalCode());
            row.put("department", m.getDepartment());
            row.put("diagnosis", m.getDiagnosisBrief());
            row.put("content", m.getOcrText());
            out.add(row);
        }

        grants.recordAudit(r.userId(), hospitalCode, appKey,
                AccessAudit.ACTION_VIEW_DETAIL, visitDate, ids, ip);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("hospitalCode", hospitalCode);
        data.put("windowStart", r.windowStart() == null ? null : r.windowStart().toString());
        data.put("windowEnd", r.windowEnd() == null ? null : r.windowEnd().toString());
        data.put("count", out.size());
        data.put("records", out);
        /*
         * 明确告诉院方：这次调阅已被记录，且患者可见。
         * 这不是警告，是让院方知道我们这边是透明的 ——
         * 合规的医院会欢迎这一点。
         */
        data.put("auditNotice", "本次调阅已记录，患者可在智诊通中查看访问记录");
        return ResponseEntity.ok(ApiResult.ok(data));
    }

    /** 院方回执：已归档到病案 */
    @PostMapping("/patient-report/archived")
    public ResponseEntity<?> archived(
            @RequestHeader(value = "X-App-Key", required = false) String appKey,
            @RequestHeader(value = "X-Timestamp", required = false) String timestamp,
            @RequestHeader(value = "X-Nonce", required = false) String nonce,
            @RequestHeader(value = "X-Signature", required = false) String signature,
            @RequestBody(required = false) String rawBody,
            HttpServletRequest request) {

        String path = "/api/his/patient-report/archived";
        var auth = ingest.authenticate(appKey, signature, timestamp, nonce,
                "POST", path, rawBody == null ? "" : rawBody);
        if (!auth.ok()) {
            return unauthorized(auth.reason());
        }

        AccessBody body;
        List<Long> ids = new ArrayList<>();
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> m = new com.fasterxml.jackson.databind.ObjectMapper()
                    .readValue(rawBody == null ? "{}" : rawBody, Map.class);
            body = new AccessBody(str(m.get("matchCode")), str(m.get("visitDate")));
            Object rawIds = m.get("recordIds");
            if (rawIds instanceof List<?> list) {
                for (Object o : list) {
                    if (o instanceof Number n) ids.add(n.longValue());
                    else if (o instanceof String s && !s.isBlank()) ids.add(Long.parseLong(s));
                }
            }
        } catch (Exception e) {
            return badRequest("请求体解析失败：" + e.getMessage());
        }

        LocalDate visitDate = null;
        if (body.visitDate() != null && !body.visitDate().isBlank()) {
            try {
                visitDate = LocalDate.parse(body.visitDate());
            } catch (Exception e) {
                return badRequest("visitDate 格式应为 YYYY-MM-DD");
            }
        }

        String hospitalCode = auth.credential().getHospitalCode();
        var r = grants.accessForVisit(hospitalCode, appKey, body.matchCode(), visitDate, clientIp(request));
        if (!r.ok()) {
            return ResponseEntity.status(HttpStatus.FORBIDDEN)
                    .body(ApiResult.fail(40300, r.reason()));
        }

        grants.markArchived(r.userId(), hospitalCode, appKey, visitDate, ids, clientIp(request));

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("archived", true);
        data.put("message", "归档回执已记录，患者可在智诊通中看到");
        return ResponseEntity.ok(ApiResult.ok(data));
    }

    /* ============================ 患者端 ============================ */

    /** 患者查看自己的访问记录 */
    @GetMapping("/my-access-log")
    public ApiResult<List<Map<String, Object>>> myAccessLog(
            @RequestParam(defaultValue = "50") int limit) {
        long userId = CurrentUser.id();
        List<AccessAudit> list = grants.listAudits(userId, limit);
        List<Map<String, Object>> out = new ArrayList<>();
        for (AccessAudit a : list) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", a.getId());
            row.put("hospitalCode", a.getHospitalCode());
            row.put("action", a.getAction());
            row.put("visitDate", a.getVisitDate() == null ? null : a.getVisitDate().toString());
            row.put("itemCount", a.getItemCount());
            row.put("archived", a.getArchived());
            row.put("createdAt", a.getCreatedAt() == null ? null : a.getCreatedAt().toString());
            out.add(row);
        }
        return ApiResult.ok(out);
    }

    /** 患者生成匹配码 */
    @PostMapping("/binding")
    public ApiResult<Map<String, Object>> createBinding(@RequestParam String hospitalCode) {
        long userId = CurrentUser.id();
        PatientBinding b = grants.createBinding(userId, hospitalCode);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("matchCode", b.getMatchCode());
        data.put("hospitalCode", b.getHospitalCode());
        data.put("hint", "把上面的匹配码告诉挂号窗口或医生，本次就诊期间院方可调阅你的报告");
        return ApiResult.ok(data);
    }

    /** 患者查看已有匹配码 */
    @GetMapping("/binding")
    public ApiResult<List<Map<String, Object>>> listBinding() {
        long userId = CurrentUser.id();
        List<Map<String, Object>> out = new ArrayList<>();
        for (PatientBinding b : grants.listBindings(userId)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("matchCode", b.getMatchCode());
            row.put("hospitalCode", b.getHospitalCode());
            row.put("createdAt", b.getCreatedAt() == null ? null : b.getCreatedAt().toString());
            out.add(row);
        }
        return ApiResult.ok(out);
    }

    /** 患者的自动授权开关 */
    @GetMapping("/auto-grant")
    public ApiResult<Map<String, Object>> getAutoGrant() {
        long userId = CurrentUser.id();
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("autoGrant", grants.autoGrantEnabled(userId));
        return ApiResult.ok(data);
    }

    @PostMapping("/auto-grant")
    public ApiResult<Map<String, Object>> setAutoGrant(@RequestParam boolean enabled) {
        long userId = CurrentUser.id();
        grants.setAutoGrant(userId, enabled);
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("autoGrant", enabled);
        return ApiResult.ok(data);
    }

    /* ============================ 辅助 ============================ */

    private static String str(Object o) {
        return o == null ? null : o.toString();
    }

    private static String clientIp(HttpServletRequest req) {
        String xff = req.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank()) return xff.split(",")[0].trim();
        return req.getRemoteAddr();
    }

    private ResponseEntity<?> unauthorized(String reason) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(ApiResult.fail(40100, reason));
    }

    private ResponseEntity<?> badRequest(String msg) {
        return ResponseEntity.badRequest().body(ApiResult.fail(40000, msg));
    }
}
