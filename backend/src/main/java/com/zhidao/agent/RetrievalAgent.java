package com.zhidao.agent;

import com.zhidao.agent.contract.AgentEvent;
import com.zhidao.agent.contract.AgentOutput;
import com.zhidao.agent.contract.RetrievalPayload;
import com.zhidao.agent.rag.Bm25Search;
import com.zhidao.agent.rag.KbDoc;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.function.BiFunction;
import java.util.regex.Pattern;

/**
 * Retrieval Agent —— 对照 frontend/server/agents/retrieval.ts。
 *
 * <p>五步流程：① 检索 ② 充分性判定 ③ 自纠改写(≤2轮) ④ 抽取式作答 ⑤ 接地检查。
 *
 * <p>诚实说明（与 TS 版注释一致）：③ 是同义词规则改写，不是 LLM；
 * ④ 是抽取式（从证据摘句），不是生成式。好处是每句都能溯源到 docId，
 * 物理上不可能编造。接真 LLM 改写时只需注入 rewriteFn，主流程不变。
 */
@Slf4j
@Component
public class RetrievalAgent {

    private static final int MAX_EXPAND_ROUNDS = 2;
    private static final double EVIDENCE_TOP_SCORE = 0.75;
    private static final int EVIDENCE_MIN_DOCS = 2;
    private static final int SNIPPET_LEN = 120;

    /** 同义词表 —— 逐条对照 TS 版 SYNONYMS */
    private static final List<Synonym> SYNONYMS = List.of(
            new Synonym(Pattern.compile("血糖|糖尿"), "血糖 空腹血糖"),
            new Synonym(Pattern.compile("血压|高压|低压"), "血压 血压偏高"),
            new Synonym(Pattern.compile("头晕|眩晕|晕"), "头晕 眩晕"),
            new Synonym(Pattern.compile("肚子|腹部|胃不舒|胃疼|胃痛"), "腹痛 上腹部疼痛"),
            new Synonym(Pattern.compile("咳嗽|咳"), "咳嗽 咳痰"),
            new Synonym(Pattern.compile("过敏"), "过敏 过敏史 药物过敏"),
            new Synonym(Pattern.compile("检查|化验|报告"), "检查 化验 重复检查"),
            new Synonym(Pattern.compile("挂号|就诊|看病|准备"), "就诊准备 材料"),
            new Synonym(Pattern.compile("复诊|随访|复查"), "复诊 慢性病")
    );

    private static final Pattern ACTION_WORD = Pattern.compile("建议|需要|应|可以|带上|记录|告知|就诊");
    private static final Pattern SENTENCE_SPLIT = Pattern.compile("[。；]");

    private record Synonym(Pattern pattern, String replacement) {}

    private final Bm25Search search;

    public RetrievalAgent(Bm25Search search) {
        this.search = search;
    }

    /** 查询改写：只做一轮同义词扩展，第二轮不扩（对照 expandQuery） */
    public String expandQuery(String raw, int round) {
        if (round >= MAX_EXPAND_ROUNDS) return raw;
        String out = raw;
        for (Synonym s : SYNONYMS) {
            out = s.pattern().matcher(out).replaceAll(s.replacement());
        }
        return out;
    }

    /** 从证据里挑句子 —— 对照 pickSentences。关键：句子必须含本文档自己的命中词 */
    private List<String> pickSentences(Bm25Search.SearchHit hit, int maxSentences) {
        String[] sentences = SENTENCE_SPLIT.split(hit.getDoc().getContent());
        List<String> candidates = new ArrayList<>();
        for (String s : sentences) {
            String trimmed = s.trim();
            if (trimmed.length() >= 8) candidates.add(trimmed);
        }
        if (candidates.isEmpty()) return Collections.emptyList();

        List<String> terms = hit.getMatchedTerms();
        record Scored(String s, int score, int hitCount) {}
        List<Scored> scored = new ArrayList<>();
        for (String s : candidates) {
            int hitCount = 0;
            for (String t : terms) if (s.contains(t)) hitCount++;
            int actionBonus = ACTION_WORD.matcher(s).find() ? 1 : 0;
            scored.add(new Scored(s, hitCount * 2 + actionBonus, hitCount));
        }
        // 没有命中词的句子直接丢弃 —— 串味的根源
        List<Scored> relevant = new ArrayList<>();
        for (Scored x : scored) if (x.hitCount() > 0) relevant.add(x);
        if (relevant.isEmpty()) return Collections.emptyList();

        relevant.sort((a, b) -> Integer.compare(b.score(), a.score()));
        List<String> out = new ArrayList<>();
        for (int i = 0; i < Math.min(maxSentences, relevant.size()); i++) out.add(relevant.get(i).s());
        return out;
    }

    /** 接地检查 —— 对照 groundingCheck：>50% bigram 在证据里找得到才保留 */
    public GroundingResult groundingCheck(String answer, List<RetrievalPayload.Source> sources) {
        String[] sentences = answer.split("。");
        StringBuilder corpus = new StringBuilder();
        for (RetrievalPayload.Source s : sources) corpus.append(s.getSnippet());

        List<String> kept = new ArrayList<>();
        int removed = 0;
        for (String s : sentences) {
            if (s.trim().isEmpty()) continue;
            List<String> grams = new ArrayList<>();
            for (int i = 0; i < s.length() - 1; i++) grams.add(s.substring(i, i + 2));
            if (grams.isEmpty()) {
                kept.add(s);
                continue;
            }
            int found = 0;
            for (String g : grams) if (corpus.indexOf(g) >= 0) found++;
            if ((double) found / grams.size() >= 0.5) kept.add(s);
            else removed++;
        }
        return new GroundingResult(String.join("。", kept), removed);
    }

    public record GroundingResult(String answer, int removed) {}

    /**
     * 主处理 —— 对照 makeRetrieval 的 handle。
     *
     * @param text      用户问题（已脱敏）
     * @param rewriteFn 可选 LLM 改写 (query, round) -> 改写结果；null 表示只用规则
     */
    public AgentOutput<RetrievalPayload> run(String text, BiFunction<String, Integer, String> rewriteFn) {
        long started = System.currentTimeMillis();
        List<AgentEvent> events = new ArrayList<>();
        List<String> refinedQueries = new ArrayList<>();
        String query = text;

        // ①② 检索 + 充分性
        List<Bm25Search.SearchHit> hits = search.search(query, 5);
        int roundsUsed = 0;

        // ③ 自纠循环
        while (!isSufficient(hits) && roundsUsed < MAX_EXPAND_ROUNDS) {
            roundsUsed++;
            String next = null;
            if (rewriteFn != null) {
                try {
                    next = rewriteFn.apply(query, roundsUsed);
                } catch (Exception e) {
                    log.warn("[检索] LLM 改写失败，退回规则改写: {}", e.getMessage());
                }
            }
            String expanded = next != null ? next : expandQuery(query, roundsUsed);
            if (expanded.equals(query)) break;
            query = expanded;
            refinedQueries.add(query);
            events.add(AgentEvent.retry("证据不足，已扩展检索词", "retrieval", "retrieval", roundsUsed));
            hits = search.search(query, 5);
        }

        // 来源列表
        List<RetrievalPayload.Source> sources = new ArrayList<>();
        for (Bm25Search.SearchHit h : hits) {
            KbDoc doc = h.getDoc();
            String content = doc.getContent();
            sources.add(RetrievalPayload.Source.builder()
                    .docId(doc.getDocId())
                    .title(doc.getTitle())
                    .snippet(content.substring(0, Math.min(SNIPPET_LEN, content.length())))
                    .score(h.getScore())
                    .build());
        }
        boolean lowEvidence = !isSufficient(hits);

        // 无证据：如实说
        if (hits.isEmpty()) {
            events.add(AgentEvent.caveat(
                    "未检索到相关资料，无法给出有依据的回答。建议咨询医生或到门诊导诊台询问。"));
            return AgentOutput.<RetrievalPayload>builder()
                    .status(AgentOutput.FAILED)
                    .payload(RetrievalPayload.builder()
                            .answer("知识库里没有检索到与这个问题直接相关的资料。")
                            .sources(Collections.emptyList())
                            .roundsUsed(roundsUsed)
                            .refinedQueries(refinedQueries)
                            .lowEvidence(true)
                            .build())
                    .confidence(0)
                    .evidence(Collections.emptyList())
                    .events(events)
                    .build();
        }

        // ④ 抽取式作答
        List<String> picked = new ArrayList<>();
        for (Bm25Search.SearchHit h : hits.subList(0, Math.min(2, hits.size()))) {
            picked.addAll(pickSentences(h, 2));
        }
        String answer = picked.isEmpty() ? "" : String.join("。", picked) + "。";

        // ⑤ 接地检查
        GroundingResult grounded = groundingCheck(answer, sources);
        answer = !grounded.answer().isEmpty() ? grounded.answer() + "。" : answer;
        if (grounded.removed() > 0) {
            events.add(AgentEvent.caveat("已删除 " + grounded.removed() + " 句缺乏资料依据的内容。"));
        }
        if (lowEvidence) {
            events.add(AgentEvent.caveat(
                    "本问题检索到的资料较少，以上内容仅供参考，建议以医生意见为准。"));
        }

        // 来源事件
        Map<String, Object> toolResult = new LinkedHashMap<>();
        toolResult.put("count", sources.size());
        toolResult.put("sources", sources);
        events.add(AgentEvent.toolResult("hybrid_search", true, toolResult));

        // 溯源引用（粗粒度 span）
        List<Map<String, Object>> evidence = new ArrayList<>();
        for (Bm25Search.SearchHit h : hits) {
            evidence.add(Map.of("type", "doc", "id", h.getDoc().getDocId(),
                    "span", List.of(0, h.getDoc().getContent().length())));
        }

        double confidence = lowEvidence ? 0.45 : Math.min(0.85, 0.6 + hits.size() * 0.05);
        confidence = Math.round(confidence * 100.0) / 100.0;

        log.debug("[检索] query={} hits={} rounds={} lowEvidence={} elapsed={}ms",
                query, hits.size(), roundsUsed, lowEvidence, System.currentTimeMillis() - started);

        return AgentOutput.<RetrievalPayload>builder()
                .status(AgentOutput.OK)
                .payload(RetrievalPayload.builder()
                        .answer(answer)
                        .sources(sources)
                        .roundsUsed(roundsUsed)
                        .refinedQueries(refinedQueries)
                        .lowEvidence(lowEvidence)
                        .build())
                .confidence(confidence)
                .evidence(evidence)
                .events(events)
                .build();
    }

    /** 便捷重载：无 LLM 改写 */
    public AgentOutput<RetrievalPayload> run(String text) {
        return run(text, null);
    }

    private boolean isSufficient(List<Bm25Search.SearchHit> hits) {
        return hits.size() >= EVIDENCE_MIN_DOCS
                && !hits.isEmpty()
                && hits.get(0).getScore() >= EVIDENCE_TOP_SCORE;
    }
}
