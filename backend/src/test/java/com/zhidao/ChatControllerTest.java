package com.zhidao;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhidao.agent.contract.AgentEvent;
import com.zhidao.controller.ChatController;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * ChatController 契约测试：输入校验 + SSE 帧格式 + 端点可用性。
 */
@SpringBootTest
@AutoConfigureMockMvc
class ChatControllerTest {

    @Autowired private MockMvc mockMvc;
    @Autowired private ObjectMapper objectMapper;
    @Autowired private ChatController chatController;

    @Test
    @DisplayName("空白输入 → 400 text_required")
    void blankText() throws Exception {
        mockMvc.perform(post("/api/chat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("text", "   "))))
                .andExpect(status().isBadRequest());
    }

    @Test
    @DisplayName("超长输入 → 413 text_too_long")
    void tooLong() throws Exception {
        String longText = "症".repeat(2001);
        mockMvc.perform(post("/api/chat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("text", longText))))
                .andExpect(status().is(413));
    }

    @Test
    @DisplayName("SSE 帧格式：event: type + data: json，与 sse.ts 一致")
    void sseFrameFormat() throws Exception {
        String frame = chatController.toSseFrame(AgentEvent.token("你好"));
        assertThat(frame).startsWith("event: token\n");
        assertThat(frame).contains("data: {");
        assertThat(frame).contains("\"text\":\"你好\"");
        assertThat(frame).endsWith("\n\n");
    }

    @Test
    @DisplayName("SSE 端点异步启动（SseEmitter）")
    void sseEndpointStartsAsync() throws Exception {
        // MockMvc 对自定义线程池里的 SseEmitter 写入时序不可靠，
        // 这里只验证端点以 async 方式启动；帧格式由 sseFrameFormat 覆盖。
        mockMvc.perform(post("/api/chat")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "text", "胸口疼得厉害", "turnId", "t-sse"))))
                .andExpect(request().asyncStarted());
    }

    @Test
    @DisplayName("健康检查端点公开可用")
    void health() throws Exception {
        mockMvc.perform(get("/api/chat/health"))
                .andExpect(status().isOk());
    }
}
