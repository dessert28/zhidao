package com.zhidao.agent.rag;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;

/**
 * 知识库条目 —— 对照 frontend/server/rag/kb.ts 的 KbDoc。
 *
 * <p>从 resources/kb-docs.json 加载。字段与 TS 版严格一致，
 * 保证检索结果可以逐条比对（迁移验证的基准）。
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class KbDoc {
    private String docId;
    /** 来源机构，用于引用展示时标注可信度 */
    private String source;
    private String title;
    /** 分块正文 */
    private String content;
    /** 科室标签，与 Triage 的科室体系对齐 */
    private List<String> departments;
    /** 关键词标签，弥补分词不足 */
    private List<String> tags;
}
