package com.zhidao.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.time.LocalDate;

/**
 * 院方知识库文档上传请求 —— <b>为预留接口定义的契约，当前没有代码使用它</b>。
 *
 * <p>它现在唯一的作用是「把接口文档写进类型系统」：
 * 下一位开发者不必从 javadoc 里猜字段名，编译器会告诉他
 * {@code KnowledgeAdminController} 期望什么样的请求体。
 *
 * <p>字段设计的理由：
 * <ul>
 *   <li><b>{@code docType}</b> 用受限字符串而不是自由文本：知识库的检索质量
 *       高度依赖「这类文档该怎么切分」，类型一乱，切分策略就无从选择。
 *       约定取值 {@code NOTICE}（就诊须知）/ {@code DEPARTMENT_INTRO}（科室介绍）。
 *       暂不定义 enum，是因为将来院方大概率还会加「检查须知」「用药指导」，
 *       枚举每加一项都要改代码，先用校验约束住取值范围更灵活。</li>
 *   <li><b>{@code hospitalCode} / {@code department}</b> 决定检索时的过滤范围：
 *       患者问「内科在哪」时，不该召回另一家医院的科室介绍。
 *       都可以为空 —— 空表示「全院通用」，例如停车、取号这类须知。</li>
 *   <li><b>{@code effectiveFrom} / {@code expireAt}</b> 是「过期内容检测」的落点：
 *       院方的须知天然带时效（节假日门诊安排、装修期间的入口变更）。
 *       没有这两个字段，过期文档会一直排在检索结果第一位，
 *       而这种错误对患者来说比「搜不到」更难发现。</li>
 * </ul>
 *
 * <p><b>注意</b>：加 {@code @NotBlank} 不代表接口现在会做校验 ——
 * 预留端点直接返回 501，不会进入参数校验。这些注解是给实现阶段直接复用的。
 */
public record KnowledgeDocRequest(
        @NotBlank(message = "标题不能为空")
        @Size(max = 200, message = "标题过长")
        String title,

        @NotBlank(message = "文档类型不能为空")
        String docType,

        /** 院区编码；为空表示全院通用 */
        String hospitalCode,

        /** 科室名称；为空表示不限定科室 */
        String department,

        @NotBlank(message = "正文不能为空")
        String content,

        /** 生效日期；为空表示立即生效 */
        LocalDate effectiveFrom,

        /** 失效日期；为空表示长期有效。到点后应由定时任务标为过期而不是直接删除 */
        LocalDate expireAt
) {
}
