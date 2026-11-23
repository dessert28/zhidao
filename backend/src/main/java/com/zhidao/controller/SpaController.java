package com.zhidao.controller;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * 前端静态产物托管 —— BFF 下线后由 Spring Boot 同源提供前端。
 *
 * <p>替代 Node standalone.ts 的"一个进程同时托管静态与 API"：
 * 构建时把 frontend/dist/* 拷到 backend/src/main/resources/static/，
 * Spring Boot 启动后 / 返回 index.html，/assets/* 由默认静态映射处理。
 *
 * <p>SPA fallback：React Router 的前端路由（如 /patient/records）刷新时
 * 服务端没有对应文件，回退到 index.html 交给前端路由。
 * 注意 /api/** 不走这里 —— 那些路径有真实 Controller，返回 404 是诚实的；
 * 若把它们回退成 200+HTML，前端 fetch 会拿到 HTML 然后 JSON 解析失败
 * （旧 BFF 踩过完全相同的坑，见 vite.config.ts 历史注释）。
 */
@RestController
public class SpaController {

    private final Resource index = new ClassPathResource("static/index.html");

    /**
     * 兜底路由：只匹配不含点号且不以 api/ 开头的路径（前端路由形态）。
     * /assets/xxx.js 这类带扩展名的走 Spring Boot 默认静态映射，不进这里。
     */
    @GetMapping(path = {
            "/", "/{segment}",
            "/{seg1}/{seg2}", "/{seg1}/{seg2}/{seg3}"
    })
    public ResponseEntity<byte[]> spaFallback(HttpServletRequest request) {
        String path = request.getRequestURI();
        // 明确排除 API 路径（虽然它们有自己的 Controller，防御性挡一下）
        if (path.startsWith("/api")) {
            return ResponseEntity.notFound().build();
        }
        try {
            if (!index.exists() || index.contentLength() == 0) {
                // 没构建前端产物时不假装成功 —— 给一个可操作的提示
                String msg = "<html><body><h2>前端尚未构建</h2><p>请先执行 "
                        + "<code>cd frontend &amp;&amp; pnpm build</code>，"
                        + "再把 dist/* 拷到 backend/src/main/resources/static/。</p></body></html>";
                return ResponseEntity.ok().contentType(MediaType.TEXT_HTML)
                        .body(msg.getBytes(StandardCharsets.UTF_8));
            }
            byte[] html = index.getInputStream().readAllBytes();
            return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(html);
        } catch (IOException e) {
            return ResponseEntity.internalServerError().build();
        }
    }
}
