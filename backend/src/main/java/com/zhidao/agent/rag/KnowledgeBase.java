package com.zhidao.agent.rag;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.util.Collections;
import java.util.List;

/**
 * 知识库加载器 —— 对照 frontend/server/rag/kb.ts 的 KB_DOCS。
 *
 * <p>TS 版把 20 条静态数据硬编码在源码里；这里改成从 JSON 资源加载，
 * 内容逐字一致（由迁移脚本从 kb.ts 提取），只是存储形态不同。
 * 这样做的好处：换真实知识库时只换 JSON，不动检索代码。
 */
@Slf4j
@Component
public class KnowledgeBase {

    private final ObjectMapper objectMapper;

    @Getter
    private List<KbDoc> docs = Collections.emptyList();

    public KnowledgeBase(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @PostConstruct
    public void load() {
        try (InputStream in = new ClassPathResource("kb-docs.json").getInputStream()) {
            docs = Collections.unmodifiableList(
                    objectMapper.readValue(in, new TypeReference<List<KbDoc>>() {}));
            log.info("[知识库] 加载 {} 条文档", docs.size());
        } catch (Exception e) {
            // 知识库是 RAG 的地基，加载失败必须让启动失败 —— 静默降级会让
            // 检索永远返回空，而前端看起来只是"AI 没回答"，极难排查。
            throw new IllegalStateException("无法加载 kb-docs.json", e);
        }
    }

    public int size() {
        return docs.size();
    }
}
