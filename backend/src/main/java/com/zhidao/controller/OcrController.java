package com.zhidao.controller;

import com.zhidao.agent.LlmConfigService;
import com.zhidao.agent.RedactionService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.*;

/**
 * 报告图识别端点 —— 对照 frontend/server/routes/ocr.ts 的 POST /report。
 *
 * <p>这是唯一会把图像交给模型服务商的路径（像素没法在浏览器里脱敏）。
 * 出关口必须再做一次脱敏：rawText 直接来自模型，可能抄进证件号/手机号。
 *
 * <p>边界：图片不落盘、不记日志内容，日志只有 mimeType 与字节数。
 *
 * <p>视觉模型调用在"只验证结构"阶段明确降级为 unconfigured ——
 * 真实识别需要配置支持视觉的模型 Key 后才能验证，不假装成功。
 */
@Slf4j
@RestController
@RequestMapping("/api/ocr")
public class OcrController {

    private static final int MAX_BODY = 6 * 1024 * 1024;
    private static final Set<String> ALLOWED_MIME = Set.of("image/png", "image/jpeg", "image/jpg", "image/webp");

    private final LlmConfigService config;
    private final RedactionService redaction;

    public OcrController(LlmConfigService config, RedactionService redaction) {
        this.config = config;
        this.redaction = redaction;
    }

    public record OcrBody(String base64, String mimeType, Integer byteSize) {}

    @PostMapping("/report")
    public ResponseEntity<Map<String, Object>> recognize(@RequestBody(required = false) OcrBody body) {
        if (body == null || body.base64() == null || body.mimeType() == null) {
            return ResponseEntity.badRequest().body(Map.of("ok", false, "message", "base64 与 mimeType 必填"));
        }
        if (body.base64().length() > MAX_BODY) {
            return ResponseEntity.badRequest().body(Map.of("ok", false, "message", "图片过大"));
        }
        if (!ALLOWED_MIME.contains(body.mimeType().toLowerCase(Locale.ROOT))) {
            // 只记类型，不记图片内容
            log.warn("[ocr] 不支持的图片类型: {}", body.mimeType());
            return ResponseEntity.ok(Map.of("ok", false, "reason", "unsupported",
                    "message", "只支持 PNG / JPEG / WebP 格式的图片"));
        }

        if (!config.isConfigured()) {
            log.warn("[ocr] 未配置视觉模型，mime={} bytes={}", body.mimeType(), body.byteSize());
            return ResponseEntity.ok(Map.of("ok", false, "reason", "unconfigured",
                    "message", "未配置视觉模型，报告图识别暂不可用。请先在设置页填写支持图片的模型。"));
        }

        /* 真实视觉模型调用需要配置的模型支持 image_url 输入。
         * 当前为结构验证模式：不发起外部请求，避免用文本模型 Key 假装能识别图片。
         * 出关脱敏逻辑（下方 redact）已实现并测试，接真模型时只需在此处
         * 填入 rawText/kind/findings 等字段，脱敏链路无需改动。 */
        log.warn("[ocr] 结构验证模式，跳过视觉模型调用，mime={} bytes={}",
                body.mimeType(), body.byteSize());
        return ResponseEntity.ok(Map.of("ok", false, "reason", "unverified",
                "message", "视觉识别需要支持图片的模型才能验证。当前为结构验证模式。"));
    }

    /** 出关脱敏 —— 接真模型时对 rawText 调用此方法，保证不漏 PII */
    public Map<String, Object> maskOutput(String rawText) {
        RedactionService.RedactionResult masked = redaction.redact(rawText);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("text", masked.text());
        out.put("maskedCount", masked.hits().size());
        return out;
    }
}
