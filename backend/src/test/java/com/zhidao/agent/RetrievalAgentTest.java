package com.zhidao.agent;

import com.zhidao.agent.contract.AgentOutput;
import com.zhidao.agent.contract.RetrievalPayload;
import com.zhidao.agent.rag.Bm25Search;
import com.zhidao.agent.rag.KnowledgeBase;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Retrieval Agent 迁移对照测试。
 *
 * <p>期望值来自 TS 版 makeRetrieval() 的实际运行输出（tsx golden 脚本采集）。
 * 包括那些反直觉的行为（接地检查删空答案、无关 query 假阳性命中）——
 * 迁移的目标是行为一致，不是"改得更好"。
 */
class RetrievalAgentTest {

    private RetrievalAgent agent;

    @BeforeEach
    void setUp() {
        KnowledgeBase kb = new KnowledgeBase(new ObjectMapper());
        kb.load();
        agent = new RetrievalAgent(new Bm25Search(kb));
    }

    @Test
    @DisplayName("query: 血糖高要注意什么 —— 逐字对齐 TS 版答案")
    void bloodSugar() {
        AgentOutput<RetrievalPayload> out = agent.run("血糖高要注意什么");
        assertEquals(AgentOutput.OK, out.getStatus());
        assertEquals(0, out.getPayload().getRoundsUsed());
        assertEquals(2, out.getPayload().getSources().size());
        assertEquals("kb-001", out.getPayload().getSources().get(0).getDocId());
        assertEquals(0.7, out.getConfidence(), 0.001);
        assertEquals(
                "若空腹血糖在 6.1–7.0 mmol/L 之间，属于空腹血糖受损，建议到内分泌科复查。"
                        + "若两次不同日空腹血糖均达到或超过 7.0 mmol/L，应尽快到内分泌科就诊，由医生判断是否需要进一步检查。"
                        + "多数常规化验（血常规、肝肾功能、血糖血脂）在 1–3 个月内通常具有参考价值。",
                out.getPayload().getAnswer());
    }

    @Test
    @DisplayName("query: 头疼该挂什么科 —— 接地检查删空答案（TS 版同样行为）")
    void headacheEmptiedByGrounding() {
        AgentOutput<RetrievalPayload> out = agent.run("头疼该挂什么科");
        assertEquals(AgentOutput.OK, out.getStatus());
        assertEquals(3, out.getPayload().getSources().size());
        assertEquals(0.75, out.getConfidence(), 0.001);
        // TS 版这里答案为空：抽取的句子 bigram 与 snippet 重合不足 50%，被接地检查全删
        assertEquals("", out.getPayload().getAnswer());
    }

    @Test
    @DisplayName("query: 完全不相关 —— bigram 假阳性命中（TS 版同样行为）")
    void irrelevantFalsePositive() {
        AgentOutput<RetrievalPayload> out = agent.run("完全不相关的xyz123");
        assertEquals(AgentOutput.OK, out.getStatus());
        assertEquals(0.75, out.getConfidence(), 0.001);
        assertEquals(
                "就诊时医生会关注：疼痛是否与活动相关、是否有外伤史、是否伴下肢麻木或放射痛、晨起是否僵硬。",
                out.getPayload().getAnswer());
    }

    @Test
    @DisplayName("无证据 query —— failed 状态 + caveat 事件")
    void noEvidence() {
        // 只有虚词的 query，tokenize 后为空 → 检索无命中
        AgentOutput<RetrievalPayload> out = agent.run("的吗呢吧");
        assertEquals(AgentOutput.FAILED, out.getStatus());
        assertTrue(out.getPayload().getSources().isEmpty());
        assertEquals("知识库里没有检索到与这个问题直接相关的资料。", out.getPayload().getAnswer());
        assertTrue(out.getEvents().stream().anyMatch(e -> "caveat".equals(e.getType())));
    }

    @Test
    @DisplayName("查询改写：同义词扩展，round>=2 不再改写")
    void expandQuery() {
        String once = agent.expandQuery("我血糖高", 0);
        assertEquals("我血糖 空腹血糖高", once, "与 TS 版 expandQuery(round=0) 一致");
        String stillExpanded = agent.expandQuery("我血糖高", 1);
        assertEquals("我血糖 空腹血糖高", stillExpanded, "round=1 仍改写（MAX=2 是达到 2 才停）");
        String twice = agent.expandQuery("我血糖高", 2);
        assertEquals("我血糖高", twice, "round>=2 不再改写");
    }

    @Test
    @DisplayName("接地检查：bigram 重合不足的句子全部删除（对齐 TS 版）")
    void groundingRemovesUnrelated() {
        RetrievalPayload.Source src = RetrievalPayload.Source.builder()
                .docId("kb-001").title("t").snippet("空腹血糖的正常参考范围是三点九到六点一").score(1).build();
        // TS 版对这个输入的实测输出是 answer=""、removed=2 ——
        // 因为 snippet 太短，连"空腹血糖偏高建议复查"的 bigram 重合都不足 50%。
        // 迁移追求行为一致，不追求"看起来更聪明"，所以照抄这个结果。
        RetrievalAgent.GroundingResult r = agent.groundingCheck(
                "空腹血糖偏高建议复查。今天天气非常好适合出去玩。", List.of(src));
        assertEquals("", r.answer());
        assertEquals(2, r.removed());

        // 换一个 snippet 足够长的用例，验证"有依据的句子会被保留"
        RetrievalPayload.Source richSrc = RetrievalPayload.Source.builder()
                .docId("kb-001").title("t")
                .snippet("空腹血糖的正常参考范围通常是 3.9–6.1 mmol/L。"
                        + "若空腹血糖在 6.1–7.0 mmol/L 之间，属于空腹血糖受损，建议到内分泌科复查。")
                .score(1).build();
        RetrievalAgent.GroundingResult r2 = agent.groundingCheck(
                "若空腹血糖在 6.1–7.0 mmol/L 之间，属于空腹血糖受损，建议到内分泌科复查。今天天气非常好。",
                List.of(richSrc));
        assertTrue(r2.answer().contains("空腹血糖"), "有依据的句子保留: " + r2.answer());
        assertFalse(r2.answer().contains("天气"));
        assertEquals(1, r2.removed());
    }
}
