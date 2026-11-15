package com.zhidao.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 院内地点 —— 「在院内」那一段的导航数据。
 *
 * <p>一条记录是一个可以被"导航到"的地点：抽血窗口、某科室诊区、
 * 药房、缴费窗口、取报告自助机。
 *
 * <p><b>为什么做成表而不是写死在代码里</b>：楼层分布是每家医院自己的事实，
 * 换一家医院就得重录一遍。写成表，医院运营人员自己就能维护；
 * 写死在代码里则每接一家都要改代码发版。
 *
 * <p><b>关于 {@code dataQuality}</b>：这是这张表里最不能省的一列。
 * 演示数据里的楼层是按三甲医院通用布局构造的，
 * 界面上必须标出来 —— 把编的楼层说成真的，比不做导航更糟。
 * 真实接入时院方提供数据，把这一列改成 {@code REAL} 即可。
 */
@Data
@TableName("hospital_place")
public class HospitalPlace {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 院区标识，与 hospital.hospitalCode 对应；不是外键，理由同 Hospital */
    private String hospitalCode;

    /**
     * 地点类型，决定它出现在就诊流程的哪一步：
     * REGISTER 挂号 / LAB 检验 / CLINIC 诊区 / EXAM 检查 /
     * PHARMACY 药房 / CASHIER 收费 / REPORT 取报告 / OTHER 其他
     */
    private String placeType;

    /** 科室；为空表示与科室无关（如一楼总服务台） */
    private String department;

    /** 展示名，如「门诊三楼检验科抽血窗口」 */
    private String name;

    /** 楼栋，如「门诊楼」 */
    private String building;

    /** 楼层，如「3F」 */
    private String floor;

    /** 口语化指引，不是坐标 —— 患者要的是"进门直走到底右手电梯"，不是经纬度 */
    private String directions;

    /** 服务时间。用文本而不拆成结构化时间表：院方公告本身就是一句话 */
    private String openHours;

    /** 处理时长（分钟），用于估算"还要多久" */
    private Integer estMinutes;

    /** 同一阶段内多个地点时，数字小的先做 */
    private Integer sortOrder;

    /** REAL 院方提供 / SAMPLE 演示示意 */
    private String dataQuality;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
