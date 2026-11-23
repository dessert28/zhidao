package com.zhidao.agent;

import com.fasterxml.jackson.databind.JsonNode;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.regex.Pattern;

/**
 * 术语释义清洗 —— 对照 frontend/server/report/term-explainer.ts。
 *
 * <p>双层约束的第二层（提示词是第一层）：拿到模型输出后再过滤一遍，
 * 出现判断/建议措辞、原文里不存在的词、含 PII 的解释，整条丢弃。
 * 提示词是请求，过滤器才是保证 —— 模型偶尔不听话是常态，
 * 而这里的错话会被患者当成医嘱。纯规则，可单测。
 */
@Slf4j
@Component
public class TermExplainer {

    /** 判断性/建议性措辞，命中即丢弃整条 —— 逐字对齐 JUDGEMENT_RE */
    private static final Pattern JUDGEMENT = Pattern.compile(
            "要紧|严重|危险|紧急|立即|马上|必须|建议|应该|应当|可以考虑|可能是|可能为|考虑为|考虑是|提示|诊断为|确诊|治疗|手术|用药|服药|癌|恶性|良性|不要紧|没问题|无大碍|影响不大|不必|无需|预后|生存");

    private static final int MIN_EXPLANATION = 6;
    private static final int MAX_EXPLANATION = 60;
    private static final int MAX_AI_TERMS = 6;

    public record AiTerm(String term, String explanation) {}

    /** 模型系统提示词 —— 逐字对齐 SYSTEM */
    public static final String SYSTEM_PROMPT = """
            你是医学词典的编辑，只做一件事：把检查报告里的专业术语解释成普通人能懂的字面含义。

            硬性要求：
            1. 只解释「这个词描述的是什么现象 / 是什么东西」，不评价轻重，不推测可能是哪种病，不说要不要治疗。
            2. 每条解释 10 到 45 字，一句话。
            3. 禁止出现这些词：要紧、严重、危险、建议、可能是、需要治疗、良性、恶性、癌。
            4. 只列原文里真实出现过的词，不要补充原文没有的术语；最多 6 条。
            5. 不要复述姓名、医院、日期、病历号等任何个人信息。
            6. 如果原文里没有需要解释的专业术语，返回空数组。""";

    private final RedactionService redaction;

    public TermExplainer(RedactionService redaction) {
        this.redaction = redaction;
    }

    /** 校验并清洗模型输出 —— 对照 sanitizeTerms */
    public List<AiTerm> sanitizeTerms(JsonNode raw, String text, List<String> known) {
        List<AiTerm> out = new ArrayList<>();
        if (raw == null || !raw.isObject() || !raw.has("terms") || !raw.get("terms").isArray())
            return out;

        Set<String> knownSet = new HashSet<>();
        if (known != null) for (String k : known) if (k != null && !k.trim().isEmpty()) knownSet.add(k.trim());
        Set<String> seen = new HashSet<>();

        for (JsonNode item : raw.get("terms")) {
            if (!item.isObject() || !item.has("term") || !item.has("explanation")) continue;
            String term = item.get("term").asText("").replaceAll("\\s+", "").trim();
            String explanation = item.get("explanation").asText("").replaceAll("\\s+", " ").trim();

            if (term.length() < 2 || term.length() > 14) continue;
            if (!text.contains(term)) continue;              // 原文里找不到 → 模型编的
            if (knownSet.contains(term) || seen.contains(term)) continue;
            if (explanation.length() < MIN_EXPLANATION || explanation.length() > MAX_EXPLANATION) continue;
            if (JUDGEMENT.matcher(explanation).find()) continue;
            if (redaction.hasPii(explanation)) continue;     // 兜住解释里的个人信息

            seen.add(term);
            out.add(new AiTerm(term, explanation));
            if (out.size() >= MAX_AI_TERMS) break;
        }
        return out;
    }
}
