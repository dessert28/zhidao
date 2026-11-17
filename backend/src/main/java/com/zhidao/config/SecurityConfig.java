package com.zhidao.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhidao.common.ApiResult;
import com.zhidao.security.JwtAuthenticationFilter;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

import java.nio.charset.StandardCharsets;

/**
 * 安全配置。
 *
 * <p>三件事，每件都对应一个具体的坑：
 * <ol>
 *   <li><b>无状态</b>：{@code SessionCreationPolicy.STATELESS}。
 *       比赛要求单实例部署且不引 Redis（docs/10 D6），
 *       一开 session 就直接绑死在单机内存上</li>
 *   <li><b>关 CSRF</b>：没有 Cookie 会话，CSRF 无从谈起；
 *       留着它反而会让所有 POST 接口 403</li>
 *   <li><b>401 也要返回统一响应体</b>：默认的 Spring 错误页是 HTML，
 *       前端 {@code res.json()} 会直接解析失败，表现为"点了没反应"</li>
 * </ol>
 */
@Configuration
public class SecurityConfig {

    /**
     * 401/403 的响应体由这个 mapper 序列化。
     *
     * <p><b>必须用 Spring 容器里的那个 bean，不能自己 new</b>：
     * 裸 {@code new ObjectMapper()} 没注册 JavaTimeModule，
     * 序列化 {@code ApiResult.timestamp}（LocalDateTime）时直接抛
     * InvalidDefinitionException —— 结果是 401 变成一个空的 401，
     * 前端 res.json() 照样炸。这个坑是集成测试抓出来的。
     */
    private final ObjectMapper objectMapper;

    public SecurityConfig(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Bean
    public PasswordEncoder passwordEncoder() {
        // BCrypt 自带盐，同一密码每次哈希都不同 —— 种子数据里的哈希只是它的一种
        return new BCryptPasswordEncoder();
    }

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http, JwtAuthenticationFilter jwtFilter)
            throws Exception {
        http
                .csrf(AbstractHttpConfigurer::disable)
                .cors(AbstractHttpConfigurer::disable) // 同源部署，BFF 在另一个端口时由 Vite 代理
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .headers(h -> h.frameOptions(f -> f.sameOrigin())) // H2 控制台是 iframe
                .authorizeHttpRequests(auth -> auth
                        /*
                         * 号源查询**不需要登录**。
                         *
                         * 理由：
                         *   · 号源是公开信息，不是患者隐私 ——
                         *     医院大厅的屏上就挂着，没有保护的必要
                         *   · AI 排程（BFF 的 Scheduler Agent）要能匿名查询，
                         *     否则用户必须先登录才能问"有没有号"，
                         *     而导诊的主场景恰恰是从未注册的新患者
                         *
                         * 注意只放行 **GET**。下单（POST /api/bookings）
                         * 仍需登录 —— 那是写操作，要能追溯到人。
                         * 用独立的 requestMatchers 精确区分，不整段放行。
                         */
                        /*
                         * 院内导航**不需要登录**。
                         *
                         * 理由：患者站在门诊楼里找不着抽血窗口时，
                         * 让他先登录是荒谬的 —— 这是整个系统里最急的一刻。
                         * 导航数据本身是院方公开信息（楼层索引牌上就有），
                         * 谈不上隐私。
                         *
                         * 只放行 GET：导航是只读的。
                         * 将来如果要支持"院方维护地点数据"，那是写操作，
                         * 走的是另一套权限（院方后台），不该挂在这个前缀下。
                         */
                        .requestMatchers(HttpMethod.GET, "/api/bookings/slots", "/api/bookings/hospitals")
                        .permitAll()
                        /*
                         * 院区目录与接入清单**也不需要登录**。
                         *
                         * 目录（编码 + 展示名 + 开设科室）和号源是同一种东西：
                         * 院方公开信息，大厅屏上就挂着。不放行的话，
                         * 前端上传病历时连"选哪家园区"都填不出来。
                         *
                         * 接入清单（字段说明）更是给医院信息科看的公开文档 ——
                         * 让对接方先注册一个账号才能看到"要准备哪些字段"，
                         * 是最没必要的门槛。里面没有任何患者数据或密钥。
                         */
                        .requestMatchers(
                                HttpMethod.GET,
                                "/api/bookings/hospitals/catalog",
                                "/api/bookings/integration-contract",
                                "/api/bookings/integration-spec",
                                "/api/bookings/integration-smoke-tests")
                        .permitAll()
                        .requestMatchers(HttpMethod.GET, "/api/nav/**")
                        .permitAll()
                        /*
                         * 健康探针**不需要登录**。
                         *
                         * 调用方不是人，是 K8s livenessProbe / 负载均衡 / 监控系统，
                         * 它们手里没有、也拿不到 JWT。要求鉴权的后果不是"更安全"，
                         * 而是探针恒失败 → 容器被反复重启 —— 比不探活严重得多。
                         *
                         * "放行"不等于"公开细节"：
                         * application.yml 里 endpoint.health.show-details=when-authorized，
                         * 匿名只能拿到 {"status":"UP"} 这种没有信息量的结果，
                         * 数据库连通性、磁盘水位等细节仍要登录。
                         * 暴露的端点也只有 health/info/metrics，
                         * env / heapdump 这类会吐出基础设施信息的没开。
                         *
                         * 写成 HttpMethod.GET 而不是裸路径：写明方法，
                         * 万一将来加了写操作的 actuator 端点，不至于跟着一起裸奔。
                         * 用 /actuator/health/** 是为了让 /actuator/health/liveness、
                         * /readiness 这两个 K8s 专用分组也能匿名访问 ——
                         * 它们同样只回一个 state，不涉及任何业务数据。
                         *
                         * 刻意**不放行** /actuator/info 与 /actuator/metrics：
                         * 探针只需要 health；metrics 里有 JVM/HTTP 明细，
                         * 给匿名访问没有必要。需要排障时带 JWT 就能看。
                         */
                        .requestMatchers(HttpMethod.GET, "/actuator/health", "/actuator/health/**")
                        .permitAll()
                        /*
                         * 院方调用的接口不经过 JWT。
                         *
                         * 调用方是院方服务器，不是患者，没有用户身份可言。
                         * 它们有自己的认证：appKey + HMAC 签名，在
                         * HisIngestService 里校验。
                         *
                         * **必须逐个列举，不能用 /api/his/****：
                         * 患者端的三个接口（访问记录 / 匹配码 / 自动授权开关）
                         * 也是 /api/his 前缀，但它们查的是患者自己的数据，
                         * 必须带 JWT。用通配会把它们一起放行，
                         * 结果是任何人都能读到别人的访问记录。
                         *
                         * 注意：permitAll 只表示"JWT 过滤器不拦"，
                         * 不代表"无认证"。真正的门禁在 HisController 里 ——
                         * 验签失败一律 401。
                         */
                        .requestMatchers(
                                "/api/his/places",
                                "/api/his/sign",
                                "/api/his/patient-report",
                                "/api/his/patient-report/archived")
                        .permitAll()
                        /*
                         * 预留接口：医生端预问诊摘要。
                         *
                         * **permitAll 只是「不拦 JWT」，不等于「无认证」。**
                         * 真实的门禁是 URL 路径里的那个一次性 token，将来在
                         * DoctorBriefController 里校验（一次性、短期、只读、只回脱敏摘要）。
                         * 之所以不能要求患者 JWT：医生不会、也不该注册患者账号。
                         *
                         * 当前该接口恒定返回 501 且不读取 token，
                         * 因此放行不会泄露任何数据 —— 它连数据库都不碰。
                         * 实现时必须先补 token 校验再考虑放开到什么程度，
                         * 绝不能因为「反正现在 501」而把这一步忘掉。
                         */
                        .requestMatchers("/api/doctor/brief/**")
                        .permitAll()
                        /*
                         * 预留接口：院方知识库运营（上传 / 列表 / 重建索引）。
                         *
                         * 用 hasRole("ADMIN") 而不是 authenticated()：
                         * 知识库是**院方发布给患者看的内容**，写权限等同于「对所有患者说话」，
                         * 不能开放给任何一个登录用户。
                         *
                         * 这里的表达式依赖 JwtAuthenticationFilter 的行为：
                         * 它把 JWT 里的 role 声明拼成 "ROLE_" + role 放进 authorities，
                         * 所以 hasRole("ADMIN") 实际匹配的是 ROLE_ADMIN。
                         *
                         * 现状：种子账号只有 PATIENT，故普通登录用户是 403、
                         * 未登录是 401，真正返回 501 需要等实现阶段补一个管理员账号。
                         * 不要为了「方便看到 501」把这条放宽成 authenticated()。
                         */
                        .requestMatchers("/api/admin/knowledge/**")
                        .hasRole("ADMIN")
                        .requestMatchers(
                                "/api/auth/**",
                                "/api/health",
                                "/h2-console/**",
                                "/v3/api-docs/**",
                                "/swagger-ui/**",
                                "/doc.html",
                                "/webjars/**"
                        ).permitAll()
                        .anyRequest().authenticated()
                )
                .exceptionHandling(e -> e
                        .authenticationEntryPoint((req, res, ex) ->
                                writeJson(res, HttpStatus.UNAUTHORIZED, 40100, "请先登录"))
                        .accessDeniedHandler((req, res, ex) ->
                                writeJson(res, HttpStatus.FORBIDDEN, 40300, "没有访问权限"))
                )
                .addFilterBefore(jwtFilter, UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }

    /** 把统一响应体写进 401/403，避免前端拿到一坨 HTML */
    private void writeJson(jakarta.servlet.http.HttpServletResponse res,
                           HttpStatus status, int code, String message) throws java.io.IOException {
        res.setStatus(status.value());
        res.setContentType("application/json;charset=UTF-8");
        res.getOutputStream().write(
                objectMapper.writeValueAsString(ApiResult.fail(code, message))
                        .getBytes(StandardCharsets.UTF_8));
    }
}
