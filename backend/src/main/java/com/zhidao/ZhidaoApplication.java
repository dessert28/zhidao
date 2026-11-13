package com.zhidao;

import org.mybatis.spring.annotation.MapperScan;
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
@SpringBootApplication
@EnableScheduling
@MapperScan("com.zhidao.mapper")
public class ZhidaoApplication {

    public static void main(String[] args) {
        SpringApplication.run(ZhidaoApplication.class, args);
    }
}
