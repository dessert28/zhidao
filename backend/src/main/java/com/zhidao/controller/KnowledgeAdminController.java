package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.dto.KnowledgeDocRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 院方知识库运营接口 —— <b>当前三个端点全部仅预留契约，功能待开发</b>。
 *
 * <h2>这块要解决什么</h2>
 * <p>患者问的很多问题（「抽血要空腹吗」「周末有门诊吗」「儿科在几楼」）
 * 答案在院方手里，但既不在号源接口里，也不在导航数据里。
 * 让导诊 Agent 直接读院方上传的文档，比让它「自由发挥」安全得多 ——
 * 医疗场景里，一个编造的答案比「我不知道」危害大得多。
 *
 * <h2>权限</h2>
 * <p>三个端点都要求 {@code role=ADMIN}，即 JWT 里的 {@code role} 声明为 {@code ADMIN}。
 * {@link com.zhidao.security.JwtAuthenticationFilter} 会把该声明转成 {@code ROLE_ADMIN}
 * 权限，{@link com.zhidao.config.SecurityConfig} 对本前缀用 {@code hasRole("ADMIN")} 拦截，
 * 因此：未登录 → 401；已登录的普通患者 → 403；只有院方管理员能打到业务层。
 *
 * <p>这条边界不能放宽成 {@code authenticated()}：知识库是<b>院方发布给患者看的内容</b>，
 * 谁能写它，谁就能对着所有患者说话。这不是普通业务数据，写权限必须收敛。
 *
 * <p>注意：种子数据目前只有一个 {@code PATIENT} 账号，所以<b>现在没有任何账号能越过 403</b>。
 * 这符合预留状态 —— 实现这套接口时要同时补一个管理员账号（或由部署方配置），
 * 而不是把权限规则改成「谁都能进」来方便调试。
 *
 * <h2>将来的契约</h2>
 *
 * <h3>1) {@code GET /api/admin/knowledge/documents}</h3>
 * <p>列出文档。查询参数（可选）：{@code hospitalCode}、{@code department}、
 * {@code docType}、{@code status}（{@code ACTIVE} / {@code EXPIRED} / {@code DRAFT}）、
 * {@code page} / {@code size}。
 * <p>返回分页结构（见 {@code common/PageResult}），每条至少包含：
 * {@code id}、{@code title}、{@code docType}、{@code hospitalCode}、{@code department}、
 * {@code status}、{@code effectiveFrom}、{@code expireAt}、{@code chunkCount}、
 * {@code indexedAt}、{@code updatedAt}。
 * 列表<b>不返回正文</b>：详情页才需要正文，列表里带上正文会让一次翻页响应变成几 MB。
 *
 * <h3>2) {@code POST /api/admin/knowledge/documents}</h3>
 * <p>请求体见 {@link KnowledgeDocRequest}（标题 / 类型 / 院区 / 科室 / 正文 / 生效与失效日期）。
 * <p>落库后要做的三件事（设计意图，实现时按序执行）：
 * <ol>
 *   <li><b>文档切分</b>：按语义边界切块（标题层级优先，其次段落，最后才按长度硬切），
 *       每块保留「来自哪份文档的哪一节」的引用。
 *       硬切会切出「……空腹 8 小时以」这种半句，检索到了也没法用。</li>
 *   <li><b>生成问答对</b>：对每块内容生成 1~3 个患者视角的问题
 *       （患者说「查血糖要空肚子吗」，文档里写的是「空腹血糖检测前需禁食 8 小时」，
 *       字面不重叠）。问答对是检索的补充召回路径，<b>不能替代原文</b>：
 *       命中问答对后仍要回到原文片段作答，否则模型会沿着生成的问题继续编。</li>
 *   <li><b>过期内容检测</b>：{@code expireAt} 到点后标为 {@code EXPIRED} 并移出检索索引，
 *       同时给运营方提示。只在查询时过滤是不够的 —— 过期文档留在索引里，
 *       迟早会被别的路径（如缓存、向量库快照）带出来。</li>
 * </ol>
 *
 * <h3>3) {@code POST /api/admin/knowledge/reindex}</h3>
 * <p>重建检索索引。请求体（可选）：{@code {"scope":"ALL"}} 或
 * {@code {"scope":"HOSPITAL","hospitalCode":"Z2-JFL"}}；不传等价于 {@code ALL}。
 * <p>返回：{@code {"documents":12,"chunks":148,"skippedExpired":3,"startedAt":"...","finishedAt":"..."}}。
 * <p>为什么需要显式重建：切分规则、问答对生成模型、索引结构都会演进。
 * 改完这些却不重建，检索结果会一半按新规则、一半按旧规则，且没有任何报错 ——
 * 这种「静默不一致」只能靠主动重建消除。重建应当是<b>幂等</b>的（先写新索引再切换），
 * 否则重建期间患者查知识库会拿到空结果。
 *
 * <h2>为什么现在只留契约</h2>
 * <p>完整实现等于引入「文件解析 + 切分 + 向量检索 + 内容生成」四条链路，
 * 每一条都有独立的失败模式；其中「生成问答对」还会引入大模型幻觉风险，
 * 而它面对的是患者的就医决策。省赛阶段先把接口位置和权限边界定下来，
 * 但不做半成品：返回 501 而不是空列表，前端就不会把它渲染成「知识库里有 0 篇文档」。
 */
@RestController
@RequestMapping("/api/admin/knowledge")
public class KnowledgeAdminController {

    /** 预留接口专用业务码：与 50101（医生端摘要）区分开，便于定位是哪一块没实现 */
    private static final int RESERVED_CODE = 50102;

    private static final String DOCS_RESERVED_MESSAGE =
            "院方知识库列表接口已预留：需先实现文档入库、切分与检索索引";

    private static final String UPLOAD_RESERVED_MESSAGE =
            "院方知识库上传接口已预留：需先实现文档解析、切分与问答对生成";

    private static final String REINDEX_RESERVED_MESSAGE =
            "知识库索引重建接口已预留：需先实现切分规则与检索索引";

    /**
     * 列出院方知识库文档（预留）。
     *
     * <p>当前始终返回 HTTP 501 + 业务码 50102，不查库、不返回空列表。
     * <p>为什么不返回 {@code []}：空的 200 会被前端当成「知识库还没上传过文档」，
     * 运营同学于是去查上传流程，而真正的原因是这一整块没做。
     * 501 才能把问题指向正确的位置。
     */
    @GetMapping("/documents")
    public ResponseEntity<ApiResult<Void>> documents() {
        return notImplemented(DOCS_RESERVED_MESSAGE);
    }

    /**
     * 院方上传就诊须知 / 科室介绍（预留）。
     *
     * <p>请求体按 {@link KnowledgeDocRequest} 设计，但当前<b>不绑定、不校验、不落库</b>：
     * 用 {@code required = false} 是为了让「不带请求体的探测请求」也能拿到 501 ——
     * 预留接口的响应应当只由「有没有实现」决定，不该被入参形态影响。
     * 也刻意不加 {@code @Valid}：参数校验发生在方法调用之前，
     * 加了它，一个字段没填的请求会先返回 400，反而掩盖了 501。
     *
     * <p>将来成功时返回 201 + 新建文档的 {@code id}、切分块数与索引状态。
     */
    @PostMapping("/documents")
    public ResponseEntity<ApiResult<Void>> upload(
            @RequestBody(required = false) KnowledgeDocRequest request) {
        return notImplemented(UPLOAD_RESERVED_MESSAGE);
    }

    /**
     * 重建检索索引（预留）。
     *
     * <p>当前始终返回 501。将来是全量/按院区重建，幂等且不阻塞在读请求
     * （写新索引 → 原子切换 → 删旧索引），详见类注释。
     */
    @PostMapping("/reindex")
    public ResponseEntity<ApiResult<Void>> reindex() {
        return notImplemented(REINDEX_RESERVED_MESSAGE);
    }

    /**
     * 三个端点共用同一种「预留」响应：HTTP 501 + 统一响应体 + 50102。
     *
     * <p>统一在这里构造，是为了保证状态码与业务码不会某一处写成 200/50101 之类的不一致 ——
     * 前端只需判断「50102 就是知识库待开发」。
     */
    private ResponseEntity<ApiResult<Void>> notImplemented(String message) {
        return ResponseEntity.status(HttpStatus.NOT_IMPLEMENTED)
                .body(ApiResult.fail(RESERVED_CODE, message));
    }
}
