package com.zhidao.agent.rag;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * BM25 检索的迁移对照测试。
 *
 * <p>期望值来自 TS 版 frontend/server/rag/search.ts 的实际运行输出
 * （迁移前用 tsx 跑 golden 脚本采集），不是拍脑袋写的。
 * Java 版必须逐分对齐，才能证明"迁移没走样"。
 */
class Bm25SearchTest {

    private Bm25Search search;

    @BeforeEach
    void setUp() {
        KnowledgeBase kb = new KnowledgeBase(new com.fasterxml.jackson.databind.ObjectMapper());
        kb.load();
        search = new Bm25Search(kb);
    }

    @Test
    @DisplayName("知识库加载 20 条")
    void kbSize() {
        KnowledgeBase kb = new KnowledgeBase(new com.fasterxml.jackson.databind.ObjectMapper());
        kb.load();
        assertEquals(20, kb.size());
    }

    @Test
    @DisplayName("中文 bigram 分词与 TS 版一致")
    void tokenizeMatchesTs() {
        assertEquals(
                List.of("空腹", "腹血", "血糖", "糖偏", "偏高"),
                Bm25Search.tokenize("空腹血糖偏高"));
    }

    @Test
    @DisplayName("虚词 bigram 被过滤（青霉素过敏案例）")
    void noiseBigramFiltered() {
        // "能不能"里的"不能"两字都是虚词，应被丢弃；核心词"过敏"保留
        List<String> t = Bm25Search.tokenize("青霉素过敏能不能用");
        assertFalse(t.contains("不能"), "虚词 bigram 应被过滤: " + t);
        assertTrue(t.contains("过敏"));
    }

    @Test
    @DisplayName("query: 血糖高要注意什么 —— 与 TS 黄金基准对齐")
    void queryBloodSugar() {
        List<Bm25Search.SearchHit> hits = search.search("血糖高要注意什么");
        assertEquals(2, hits.size());
        assertEquals("kb-001", hits.get(0).getDoc().getDocId());
        assertEquals(1.0, hits.get(0).getScore(), 0.001);
        assertEquals("kb-006", hits.get(1).getDoc().getDocId());
        assertEquals(0.0, hits.get(1).getScore(), 0.001);
        assertTrue(hits.get(0).getMatchedTerms().contains("血糖"));
    }

    @Test
    @DisplayName("query: 头疼该挂什么科 —— 与 TS 黄金基准对齐")
    void queryHeadache() {
        List<Bm25Search.SearchHit> hits = search.search("头疼该挂什么科");
        assertEquals(3, hits.size());
        assertEquals("kb-016", hits.get(0).getDoc().getDocId());
        assertEquals(1.0, hits.get(0).getScore(), 0.001);
        assertEquals("kb-019", hits.get(1).getDoc().getDocId());
        assertEquals(0.8, hits.get(1).getScore(), 0.001);
        assertEquals("kb-010", hits.get(2).getDoc().getDocId());
        assertEquals(0.0, hits.get(2).getScore(), 0.001);
    }

    @Test
    @DisplayName("query: 儿童发烧 —— 与 TS 黄金基准对齐")
    void queryChildFever() {
        List<Bm25Search.SearchHit> hits = search.search("儿童发烧");
        assertEquals(3, hits.size());
        assertEquals("kb-015", hits.get(0).getDoc().getDocId());
        assertEquals(1.0, hits.get(0).getScore(), 0.001);
        assertEquals(2, hits.get(0).getMatchedTerms().size(), "儿童/童发 都命中");
        assertEquals("kb-011", hits.get(1).getDoc().getDocId());
        assertEquals(0.14, hits.get(1).getScore(), 0.001);
    }

    @Test
    @DisplayName("query: 青霉素过敏 —— 噪声过滤后仍命中过敏条目")
    void queryAllergy() {
        List<Bm25Search.SearchHit> hits = search.search("青霉素过敏能不能用");
        assertEquals(3, hits.size());
        assertEquals("kb-007", hits.get(0).getDoc().getDocId());
        assertEquals(1.0, hits.get(0).getScore(), 0.001);
        assertEquals("kb-014", hits.get(1).getDoc().getDocId());
        assertEquals(0.36, hits.get(1).getScore(), 0.001);
    }

    @Test
    @DisplayName("证据充分性判据：≥2 篇且最高分≥0.75")
    void evidenceSufficient() {
        // 归一化的副作用：有 2 篇以上命中时最高分恒为 1，所以恒 true
        assertTrue(search.isEvidenceSufficient(search.search("血糖高要注意什么")));
        assertTrue(search.isEvidenceSufficient(search.search("儿童发烧")));
        // 只有 1 篇命中 → 不足
        assertFalse(search.isEvidenceSufficient(search.search("转氨酶")));
    }

    @Test
    @DisplayName("空 query 返回空，不抛异常")
    void emptyQuery() {
        assertTrue(search.search("").isEmpty());
        assertTrue(search.search("   ").isEmpty());
    }
}
