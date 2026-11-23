package com.zhidao.controller;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 前端静态产物托管 + SPA fallback —— BFF 下线后由 Spring Boot 同源提供前端。
 *
 * <p>替代 Node standalone.ts 的「一个进程同时托管静态与 API」。
 *
 * <p><b>为什么用一个 /** 入口而不是让资源处理器管 /assets/**：</b>
 * Spring MVC 的 {@code RequestMappingHandlerMapping} 优先级高于静态资源处理器
 * （{@code SimpleUrlHandlerMapping}）。只要兜底路由写了 {@code /{a}/{b}}，
 * 它就会先把 {@code /assets/index-xxx.js} 抢走并返回 index.html ——
 * 浏览器把 HTML 当 JS 执行，整页白屏。所以这里把「找文件」这件事自己做，
 * 优先级问题就不存在了。
 *
 * <p><b>产物从哪来：</b>优先读外部目录 {@code zhidao.web.dist-dir}
 * （默认 {@code ../frontend/dist}，即 pnpm build 的原地输出），
 * 找不到再退回 classpath:{@code /static/}（把 dist 打进 jar 的部署方式）。
 * 构建产物不进 git，也不该每改一次前端就重新打包后端。
 *
 * <p><b>SPA fallback：</b>前端路由（如 /records、/admin/users）刷新时服务端
 * 没有对应文件，回退到 index.html 交给前端路由；
 * 但带扩展名却找不到的（如 /assets/x.js 被删）返回 404 —— 不能拿 HTML 冒充 JS。
 */
@RestController
public class SpaController {

    private final Path distDir;

    public SpaController(@Value("${zhidao.web.dist-dir:../frontend/dist}") String distDir) {
        this.distDir = Paths.get(distDir).toAbsolutePath().normalize();
    }

    @GetMapping("/**")
    public ResponseEntity<byte[]> serve(HttpServletRequest request) {
        String path = request.getRequestURI();

        // 防御性排除：API 路径绝不回退成 HTML（否则前端 fetch 会拿到 HTML 再 JSON 解析失败）
        if (path.startsWith("/api")) {
            return ResponseEntity.notFound().build();
        }

        String relative = path.startsWith("/") ? path.substring(1) : path;
        if (relative.isEmpty()) {
            return serveFileOrIndex("index.html");
        }

        Resource file = resolve(relative);
        if (file != null) {
            return serve(file, relative);
        }

        // 带扩展名 = 找的是具体文件，找不到就老实 404
        String lastSegment = relative.substring(relative.lastIndexOf('/') + 1);
        if (lastSegment.contains(".")) {
            return ResponseEntity.notFound().build();
        }

        // 其余当前端路由处理：交给 index.html
        return serveFileOrIndex("index.html");
    }

    /**
     * 按 外部 dist → classpath 静态目录 的顺序找文件，找不到返回 null。
     *
     * <p>classpath 侧逐个试 Spring Boot 默认的四个静态位置：只有当兜底路由
     * 声明了 {@code /**} 时，原本由资源处理器负责的 {@code /doc.html}
     * （knife4j 放在 META-INF/resources 里）也会落到这里，
     * 不补这一步接口文档页会变成 404。
     */
    private static final String[] CLASSPATH_LOCATIONS = {
            "static/", "META-INF/resources/", "resources/", "public/"
    };

    private Resource resolve(String relative) {
        // 防目录穿越：规范化后必须仍在 distDir 内
        Path candidate = distDir.resolve(relative).normalize();
        if (candidate.startsWith(distDir) && Files.isReadable(candidate) && Files.isRegularFile(candidate)) {
            return new FileSystemResource(candidate);
        }
        for (String location : CLASSPATH_LOCATIONS) {
            ClassPathResource cp = new ClassPathResource(location + relative);
            if (cp.exists()) {
                return cp;
            }
        }
        return null;
    }

    private ResponseEntity<byte[]> serveFileOrIndex(String relative) {
        Resource file = resolve(relative);
        if (file == null) {
            return notBuiltHint();
        }
        return serve(file, relative);
    }

    private ResponseEntity<byte[]> serve(Resource file, String relative) {
        try {
            MediaType type = mediaTypeOf(relative);
            return ResponseEntity.ok().contentType(type).body(file.getInputStream().readAllBytes());
        } catch (IOException e) {
            return ResponseEntity.internalServerError().build();
        }
    }

    private MediaType mediaTypeOf(String relative) {
        int dot = relative.lastIndexOf('.');
        String ext = dot < 0 ? "" : relative.substring(dot + 1).toLowerCase();
        return switch (ext) {
            case "html" -> MediaType.TEXT_HTML;
            case "js", "mjs" -> MediaType.valueOf("text/javascript;charset=UTF-8");
            case "css" -> MediaType.valueOf("text/css;charset=UTF-8");
            case "json", "map" -> MediaType.APPLICATION_JSON;
            case "svg" -> MediaType.valueOf("image/svg+xml");
            case "png" -> MediaType.IMAGE_PNG;
            case "jpg", "jpeg" -> MediaType.IMAGE_JPEG;
            case "webp" -> MediaType.valueOf("image/webp");
            case "ico" -> MediaType.valueOf("image/x-icon");
            case "woff2" -> MediaType.valueOf("font/woff2");
            case "woff" -> MediaType.valueOf("font/woff");
            case "ttf" -> MediaType.valueOf("font/ttf");
            case "wasm" -> MediaType.valueOf("application/wasm");
            case "webmanifest" -> MediaType.valueOf("application/manifest+json");
            default -> MediaType.APPLICATION_OCTET_STREAM;
        };
    }

    /** 没构建前端时不假装成功 —— 给一个可操作的提示 */
    private ResponseEntity<byte[]> notBuiltHint() {
        String msg = "<html><head><meta charset=\"utf-8\"></head><body>"
                + "<h2>前端尚未构建</h2>"
                + "<p>请先执行 <code>cd frontend &amp;&amp; pnpm build</code>，"
                + "产物默认位于 <code>frontend/dist</code>，后端会直接从该目录读取"
                + "（可用 <code>zhidao.web.dist-dir</code> 指定别的目录）。</p>"
                + "</body></html>";
        return ResponseEntity.ok()
                .contentType(MediaType.TEXT_HTML)
                .body(msg.getBytes(StandardCharsets.UTF_8));
    }
}
