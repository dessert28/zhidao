package com.zhidao.agent;

import org.springframework.stereotype.Component;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * PII 脱敏服务 —— 对照 frontend/src/lib/privacy/redact.ts。
 *
 * <p>这是隐私边界的**服务端兜底**：OCR 的 rawText 直接来自模型，
 * 出关口必须再遮一次，防止模型把图上的证件号/手机号原样带进来。
 * 前端的端侧脱敏仍是第一道（原文不出设备），这里不替代它，只是兜底。
 *
 * <p>逐条对齐 TS 版规则表；用 Java 命名组取真实位置（等价 JS 的 d 标志 indices），
 * 倒序替换避免位置漂移。设计原则：宁可多遮蔽，不可漏遮蔽。
 */
@Component
public class RedactionService {

    public record RedactionHit(String type, int start, int end, String placeholder) {}

    public record RedactionResult(String text, List<RedactionHit> hits, int originalLength) {}

    private record Rule(String type, Pattern pattern, java.util.function.Function<String, String> mask,
                        String group) {}

    /** 规则表 —— 顺序重要：先长后短，身份证先于手机号 */
    private static final List<Rule> RULES = List.of(
            /*
             * 边界用环视而不是 \b：Java 的 \b 把中文当单词字符，
             * "身份证110101..."里数字前是中文时不成立，导致漏遮（实测踩过）。
             * JS 的 \b 只认 ASCII 单词字符，中文算边界。这里用显式环视还原 JS 行为。
             */
            new Rule("id_card",
                    Pattern.compile("(?<![\\dA-Za-z])[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx](?![\\dA-Za-z])"),
                    m -> m.substring(0, 4) + "*".repeat(10) + m.substring(m.length() - 4), null),
            new Rule("bank_card",
                    Pattern.compile("(?<![\\dA-Za-z])\\d{16,19}(?![\\dA-Za-z])"),
                    m -> m.substring(0, 4) + "*".repeat(Math.max(0, m.length() - 8)) + m.substring(m.length() - 4), null),
            new Rule("phone",
                    Pattern.compile("(?<!\\d)1[3-9]\\d{9}(?!\\d)"),
                    m -> m.substring(0, 3) + "****" + m.substring(m.length() - 4), null),
            new Rule("phone",
                    Pattern.compile("(?<!\\d)(?<n>\\d{3,4}[*＊●·]{3,}\\d{4})(?!\\d)"),
                    m -> m.substring(0, 3) + "****" + m.substring(m.length() - 4), "n"),
            new Rule("medical_record_no",
                    Pattern.compile("(?:病历号|就诊卡号?|住院号|门诊号)[：:\\s]*(?<n>[A-Za-z0-9]{4,20})"),
                    m -> "［病历号已遮蔽］", "n"),
            new Rule("email",
                    Pattern.compile("(?<![\\w.+-])[\\w.+-]+@[\\w-]+\\.[\\w.-]+(?![\\w.+-])"),
                    m -> {
                        int at = m.indexOf('@');
                        String user = at >= 0 ? m.substring(0, at) : m;
                        String domain = at >= 0 ? m.substring(at + 1) : "";
                        return user.substring(0, Math.min(2, user.length())) + "***@" + domain;
                    }, null),
            new Rule("address",
                    Pattern.compile("([\\u4e00-\\u9fa5]{2,8}(?:省|市|自治区))?[\\u4e00-\\u9fa5]{2,8}(?:区|县|镇)[\\u4e00-\\u9fa5]{0,12}(?:路|街|道|巷)[\\u4e00-\\u9fa5\\d]{0,12}(?:号|弄|栋|单元|室)?"),
                    m -> "［住址已遮蔽］", null)
    );

    /** 执行脱敏 —— 对照 redact() */
    public RedactionResult redact(String raw) {
        if (raw == null || raw.isEmpty())
            return new RedactionResult(raw == null ? "" : raw, List.of(), raw == null ? 0 : raw.length());

        List<RedactionHit> hits = new ArrayList<>();
        List<int[]> taken = new ArrayList<>();

        for (Rule rule : RULES) {
            Matcher m = rule.pattern().matcher(raw);
            while (m.find()) {
                int start, end;
                String target;
                if (rule.group() == null) {
                    start = m.start();
                    end = m.end();
                    target = m.group();
                } else {
                    start = m.start(rule.group());
                    end = m.end(rule.group());
                    if (start < 0 || end <= start) continue;
                    target = raw.substring(start, end);
                }
                if (target.isEmpty()) continue;
                // 防止区间重叠导致重复遮蔽
                boolean overlap = taken.stream().anyMatch(t -> start < t[1] && end > t[0]);
                if (overlap) continue;
                taken.add(new int[]{start, end});
                hits.add(new RedactionHit(rule.type(), start, end, rule.mask().apply(target)));
            }
        }

        // 倒序替换，位置不漂移
        List<RedactionHit> descending = new ArrayList<>(hits);
        descending.sort((a, b) -> Integer.compare(b.start(), a.start()));
        StringBuilder text = new StringBuilder(raw);
        for (RedactionHit h : descending) {
            text.replace(h.start(), h.end(), h.placeholder());
        }
        // 对外返回正序
        List<RedactionHit> ascending = new ArrayList<>(hits);
        ascending.sort(Comparator.comparingInt(RedactionHit::start));
        return new RedactionResult(text.toString(), ascending, raw.length());
    }

    public boolean hasPii(String raw) {
        return !redact(raw).hits().isEmpty();
    }
}
