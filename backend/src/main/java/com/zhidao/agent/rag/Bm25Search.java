package com.zhidao.agent.rag;

import lombok.Getter;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * BM25 + 中文 bigram 检索 —— 逐行对照 frontend/server/rag/search.ts。
 *
 * <p>算法细节（k1=1.5, b=0.75）与 TS 版完全一致，min-max 归一化也一致，
 * 目的只有一个：同样的 query 在两边跑出同样的分，迁移才能被验证。
 *
 * <p>关于中文分词：不引 jieba，用 bigram（"空腹血糖" → "空腹/腹血/血糖"），
 * 配合虚词过滤。这是 TS 版实测有效的免词典方案，照搬。
 */
@Component
public class Bm25Search {

    private static final double K1 = 1.5;
    private static final double B = 0.75;

    /** BM25 IDF 的相似度门槛复用：证据充分判据是「≥2 篇 且 最高分≥0.75」 */
    private static final double EVIDENCE_SCORE_THRESHOLD = 0.75;
    private static final int EVIDENCE_MIN_DOCS = 2;

    /** 中文 binary bigram 的虚词表 —— 与 TS 版 FUNCTION_CHARS 逐字一致 */
    private static final Set<Character> FUNCTION_CHARS = new HashSet<>();
    static {
        String chars = "的了是在和与或也都就还很太更最不没有能会要想"
                + "你我他她它们这那哪什么吗呢吧啊呀着过得地之其"
                + "一个些点把被让给对从到";
        for (char c : chars.toCharArray()) FUNCTION_CHARS.add(c);
    }

    private static final Pattern HAN_RUN = Pattern.compile("[\\u4e00-\\u9fa5]+");
    private static final Pattern LATIN = Pattern.compile("[a-z0-9]+");

    @Getter
    public static class SearchHit {
        private final KbDoc doc;
        /** 归一化到 0–1 的相关度 */
        private final double score;
        /** 命中的关键词，用于"为什么召回这条"的可解释性 */
        private final List<String> matchedTerms;

        public SearchHit(KbDoc doc, double score, List<String> matchedTerms) {
            this.doc = doc;
            this.score = score;
            this.matchedTerms = matchedTerms;
        }
    }

    private static class IndexedDoc {
        final KbDoc doc;
        final Map<String, Integer> tf;
        final int len;

        IndexedDoc(KbDoc doc, Map<String, Integer> tf, int len) {
            this.doc = doc;
            this.tf = tf;
            this.len = len;
        }
    }

    private static class Index {
        final List<IndexedDoc> docs;
        final Map<String, Integer> df;
        final double avgLen;
        final int n;

        Index(List<IndexedDoc> docs, Map<String, Integer> df, double avgLen, int n) {
            this.docs = docs;
            this.df = df;
            this.avgLen = avgLen;
            this.n = n;
        }
    }

    private final KnowledgeBase kb;
    private volatile Index cachedIndex;

    public Bm25Search(KnowledgeBase kb) {
        this.kb = kb;
    }

    /** 虚词 bigram 判据：两个字都是虚词才丢弃，只丢一个不算 */
    private static boolean isNoiseBigram(String gram) {
        return gram.length() == 2
                && FUNCTION_CHARS.contains(gram.charAt(0))
                && FUNCTION_CHARS.contains(gram.charAt(1));
    }

    /** 中文 + 英文混合切分，对照 TS 版 tokenize() */
    public static List<String> tokenize(String text) {
        List<String> tokens = new ArrayList<>();
        Matcher han = HAN_RUN.matcher(text);
        while (han.find()) {
            String run = han.group();
            if (run.length() == 1) {
                if (!FUNCTION_CHARS.contains(run.charAt(0))) tokens.add(run);
                continue;
            }
            for (int i = 0; i < run.length() - 1; i++) {
                String gram = run.substring(i, i + 2);
                if (!isNoiseBigram(gram)) tokens.add(gram);
            }
        }
        Matcher latin = LATIN.matcher(text.toLowerCase(Locale.ROOT));
        while (latin.find()) tokens.add(latin.group());
        return tokens;
    }

    private Index getIndex() {
        Index idx = cachedIndex;
        if (idx != null) return idx;
        synchronized (this) {
            if (cachedIndex != null) return cachedIndex;
            cachedIndex = buildIndex(kb.getDocs());
            return cachedIndex;
        }
    }

    private static Index buildIndex(List<KbDoc> docs) {
        List<IndexedDoc> indexed = new ArrayList<>();
        for (KbDoc doc : docs) {
            // 标题权重高于正文：算 TF 时把标题重复 3 次；标签重复 2 次
            List<String> tokens = new ArrayList<>();
            List<String> titleTokens = tokenize(nullToEmpty(doc.getTitle()));
            tokens.addAll(titleTokens);
            tokens.addAll(titleTokens);
            tokens.addAll(titleTokens);
            tokens.addAll(tokenize(nullToEmpty(doc.getContent())));
            if (doc.getTags() != null) {
                for (String tag : doc.getTags()) {
                    List<String> tt = tokenize(nullToEmpty(tag));
                    tokens.addAll(tt);
                    tokens.addAll(tt);
                }
            }

            Map<String, Integer> tf = new HashMap<>();
            for (String t : tokens) tf.merge(t, 1, Integer::sum);
            indexed.add(new IndexedDoc(doc, tf, tokens.size()));
        }

        Map<String, Integer> df = new HashMap<>();
        for (IndexedDoc d : indexed) {
            for (String t : d.tf.keySet()) df.merge(t, 1, Integer::sum);
        }
        double avgLen = indexed.isEmpty() ? 0
                : indexed.stream().mapToInt(d -> d.len).average().orElse(0);
        return new Index(indexed, df, avgLen, indexed.size());
    }

    /** 检索，返回按分数降序的前 limit 条（分数 min-max 归一化到 0–1） */
    public List<SearchHit> search(String query, int limit) {
        Index idx = getIndex();
        List<String> qTokens = tokenize(nullToEmpty(query));
        if (qTokens.isEmpty()) return Collections.emptyList();
        Set<String> qSet = new LinkedHashSet<>(qTokens);

        List<Object[]> rows = new ArrayList<>(); // {doc, score, matched}
        for (IndexedDoc d : idx.docs) {
            double score = 0;
            Set<String> matched = new LinkedHashSet<>();
            for (String term : qSet) {
                Integer tf = d.tf.get(term);
                if (tf == null) continue;
                int df = idx.df.getOrDefault(term, 0);
                double idf = Math.log(1 + (idx.n - df + 0.5) / (df + 0.5));
                double norm = 1 - B + B * (d.len / idx.avgLen);
                score += idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
                matched.add(term);
            }
            if (score > 0) rows.add(new Object[]{d.doc, score, matched});
        }
        if (rows.isEmpty()) return Collections.emptyList();

        rows.sort((a, b) -> Double.compare((Double) b[1], (Double) a[1]));
        double max = (Double) rows.get(0)[1];
        double min = (Double) rows.get(rows.size() - 1)[1];
        double span = max - min;

        List<SearchHit> out = new ArrayList<>();
        for (int i = 0; i < Math.min(limit, rows.size()); i++) {
            Object[] r = rows.get(i);
            double normalized = span > 1e-9
                    ? Math.round(((Double) r[1] - min) / span * 100.0) / 100.0
                    : 1.0;
            @SuppressWarnings("unchecked")
            Set<String> matched = (Set<String>) r[2];
            out.add(new SearchHit(
                    (KbDoc) r[0],
                    normalized,
                    new ArrayList<>(matched).subList(0, Math.min(6, matched.size()))));
        }
        return out;
    }

    public List<SearchHit> search(String query) {
        return search(query, 5);
    }

    /** 证据充分性判据：≥2 篇 且 最高分 ≥ 0.75 */
    public boolean isEvidenceSufficient(List<SearchHit> hits) {
        return hits.size() >= EVIDENCE_MIN_DOCS
                && !hits.isEmpty()
                && hits.get(0).getScore() >= EVIDENCE_SCORE_THRESHOLD;
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
