package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 医生端「预问诊摘要」接口 —— <b>当前仅预留契约，功能待开发</b>。
 *
 * <h2>这个接口要解决什么</h2>
 * <p>患者挂号后，医生在诊室里只有几分钟，却要重新问一遍主诉、过敏史、在吃的药。
 * 我们希望患者把导诊过程中已经填过的内容，以「一次性分享链接」的形式给医生看，
 * 医生不用装 App、不用注册患者账号，扫码/点链接就能读到一份<b>脱敏摘要</b>。
 *
 * <h2>token 语义（实现时必须逐条满足）</h2>
 * <ol>
 *   <li><b>一次性</b>：首次成功读取即作废。<b>任何</b>一次成功调阅都要让 token 失效，
 *       否则链接被转发到群里就等于病历被转发到群里。</li>
 *   <li><b>短期有效</b>：建议 ≤ 24 小时，并且与就诊时段绑定（例如「预约时间 -2h ~ +6h」）。
 *       「永久有效的分享链接」本质上是把病历公开到了互联网上。</li>
 *   <li><b>只读</b>：token 只能换摘要，不能改档案、不能下单、不能读原始病历附件。
 *       一旦允许写，token 就从「展示凭证」变成了「操作凭证」，风险量级完全不同。</li>
 *   <li><b>只返回脱敏摘要</b>：不含姓名、手机号、身份证、住址、病历原图。
 *       医生需要的是临床信息，不是身份信息；身份信息只在院内 HIS 里核对，
 *       这也和本项目「服务端不存患者身份字段」的架构一致（见 schema.sql 注释）。</li>
 * </ol>
 *
 * <h2>权限模型</h2>
 * <p>本接口<b>不要求患者 JWT</b>，凭 token 访问。
 * 设计意图很直接：医生不该为了看一眼摘要去注册一个患者账号 ——
 * 那既不符合医院的组织关系，也会把医生变成「患者体系里的一个用户」，
 * 权限模型从此含混不清。安全边界完全由 token 本身承担（熵足够大、一次性、短期）。
 *
 * <p>{@code SecurityConfig} 对本前缀配的是 {@code permitAll()}：
 * 它只表示「不要求 JWT」，<b>不代表没有门禁</b>。真正的 token 校验在实现时补在这里。
 *
 * <h2>将来成功时的返回结构（data 部分）</h2>
 * <pre>
 * {
 *   "chiefComplaint": "反复上腹隐痛 3 个月，加重 1 周",   // 主诉
 *   "presentIllness": "……",                            // 现病史（患者自述 + 导诊补全）
 *   "allergies": ["青霉素"],                            // 过敏：必须显式给空数组，不能让医生以为"没填"
 *   "medications": ["阿司匹林肠溶片", "二甲双胍"],        // 在用药
 *   "completedExams": ["空腹血糖", "糖化血红蛋白"],      // 已做检查（含时间，避免重复开单）
 *   "suggestions": ["……"],                             // 建议：来自导诊结论，措辞必须标注"非诊断"
 *   "generatedAt": "2026-11-17T09:30:00"               // 摘要生成时间，医生据此判断新鲜度
 * }
 * </pre>
 * <p>字段缺失一律给空数组/空串，不要给 {@code null}：
 * 前端拿到 null 只能显示空白，而空白在临床语境下会被读成「没有」。
 *
 * <h2>审计要求（做实现时不能省）</h2>
 * <p>每一次调阅都要留痕：<b>谁</b>（token 对应的医生标识；匿名 token 也要记录来源 IP + UA）、
 * <b>何时</b>、<b>哪份摘要</b>（患者 userId + 摘要版本/token id）、以及结果（成功/失效/重放）。
 * 理由：摘要里是患者健康信息，属于敏感个人信息，可追溯是合规底线；
 * 同时「同一 token 被第 2 次使用时」正是发现链接外泄的唯一信号。
 * 可复用现有的 {@code access_audit} 思路，但不要直接塞进患者侧的访问记录接口。
 *
 * <h2>为什么现在只留契约</h2>
 * <p>授权与令牌签发引入的是一整片<b>新的安全面</b>：token 生成熵、过期与单次消费的竞态、
 * 重放检测、撤销、审计、以及「患者误把链接发给陌生人」的兜底。
 * 省赛阶段把它做成半成品，比先不做更危险 —— 一个能用的弱 token 会被当成「已实现」，
 * 而它保护的是真实的健康数据。所以这里明确返回 501，且不预置任何「假装成功」的假数据。
 */
@RestController
@RequestMapping("/api/doctor")
public class DoctorBriefController {

    /** 预留接口专用业务码：与 50102（知识库）区分开，便于前端/日志判断是哪一块没实现 */
    private static final int RESERVED_CODE = 50101;

    /** 提示语直接告诉调用方「缺什么才能用」，而不是含糊的「暂不支持」 */
    private static final String RESERVED_MESSAGE =
            "医生端摘要接口已预留：需先实现患者授权与一次性令牌签发";

    /**
     * 医生凭患者分享的一次性 token 读取就诊摘要。
     *
     * <p><b>当前行为</b>：始终返回 HTTP 501 与业务码 50101，不读取、不校验、也不记录 token 原文。
     *
     * <p>为什么用 {@code ResponseEntity} 而不是直接返回 {@code ApiResult}：
     * 后者会让 HTTP 状态码是 200。前端、网关、监控看到 200 就会认为「接口能用」，
     * 于是把一个「待开发」当成「返回空数据」，问题会被推迟到演示现场才暴露。
     * 501 Not Implemented 是唯一诚实的表达：<b>路由存在，功能不存在</b>。
     *
     * <p>为什么连 token 都不看：当前没有任何校验能力，做「看起来像校验」的分支
     * （比如只判断长度）只会制造「这个接口好像有点用」的错觉。
     * 另外 token 属于凭证，<b>不要写进日志</b> —— 日志的可见范围通常比数据库宽。
     *
     * @param token 患者端签发的一次性分享凭证；当前实现忽略其内容
     * @return 501 + {@code ApiResult.fail(50101, ...)}
     */
    @GetMapping("/brief/{token}")
    public ResponseEntity<ApiResult<Void>> brief(@PathVariable String token) {
        return ResponseEntity.status(HttpStatus.NOT_IMPLEMENTED)
                .body(ApiResult.fail(RESERVED_CODE, RESERVED_MESSAGE));
    }
}
