package com.zhidao.controller;

import com.zhidao.adapter.HospitalAdapterRegistry;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 健康检查。无需认证。
 *
 * <p>刻意返回<b>依赖状态</b>而不只是 {@code {"status":"UP"}}：
 * 答辩现场如果院区适配器没注册上，一个孤零零的 "UP" 会让人以为一切正常。
 */
@RestController
@RequestMapping("/api/health")
@RequiredArgsConstructor
public class HealthController {

    private final HospitalAdapterRegistry adapters;

    @GetMapping
    public Map<String, Object> health() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("status", "UP");
        m.put("service", "zhidao-backend");
        m.put("time", LocalDateTime.now());
        m.put("hospitals", adapters.codes());
        // 边界声明：AI 编排不在这个模块，省得评委找错地方
        m.put("note", "AI 编排不在此模块，见 frontend/server/agents");
        return m;
    }
}
