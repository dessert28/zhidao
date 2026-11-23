package com.zhidao;

import com.alibaba.cloud.ai.autoconfigure.dashscope.DashScopeAutoConfiguration;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.ai.autoconfigure.openai.OpenAiAutoConfiguration;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * 智诊通业务层入口。
 *
 * <p>这个模块的职责边界（docs/04 §1、docs/00「AI 编排全部在前端」）：
 * <ul>
 *   <li><b>做</b>：业务闭环（档案/记录/预约）、提醒引擎（@Scheduled + 可解释规则）、
 *       院区适配（HospitalAdapter 接口 + Mock 实现）</li>
 *   <li><b>不做</b>：调用任何大模型。AI 编排全部在 frontend 侧
 *       （浏览器 + 自建 Node BFF）。Spring Boot 只提供"事实"，
 *       不参与"推理"</li>
 * </ul>
 *
 * <p>为什么这条边界如此重要：把 LLM 调用放在 Java 层，意味着要在
 * Java 里重写一遍 Agent 契约、SSE 结构、降级策略，而前端已经有一份
 * 完整且带测试的实现了。两份实现必然分叉，最终谁也说不清线上跑的是哪份。
 */
@SpringBootApplication(
        /*
         * 大作业分支：排除两个 starter 的自动装配。
         *
         * 实测（mvn test）撞出两个坑，都是"无 Key 时硬崩"，
         * 直接破坏本项目"无 Key 也能启动"的承诺（README 给评委的承诺）：
         *   1. DashScopeAutoConfiguration → 抛 "DashScope API key must be set"
         *   2. OpenAiAutoConfiguration    → 抛 "OpenAI API key must be set"
         * 它们的条件装配在没配 Key 时仍会创建 ChatModel，然后抛异常。
         *
         * 我们根本不用自动装配的 ChatModel —— ai/AiVerificationConfig 里
         * 自己 new OpenAiApi + ChatClient，且套了"Key 非空"条件。
         * 排除这两个自动装配对功能零影响，是"无 Key 也能跑"的必要前提。
         */
        exclude = {DashScopeAutoConfiguration.class, OpenAiAutoConfiguration.class}
)
@EnableScheduling
@MapperScan("com.zhidao.mapper")
public class ZhidaoApplication {

    public static void main(String[] args) {
        SpringApplication.run(ZhidaoApplication.class, args);
    }
}
