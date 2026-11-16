package com.zhidao.adapter;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;

/**
 * 院区适配器 —— 跨院能力的技术边界。
 *
 * <p>为什么要有这层抽象：智诊通的核心卖点是"跨院"，
 * 而每家医院的系统都不一样（有的能开 HL7，有的只给 HTTP JSON，
 * 有的只能靠人工录入）。如果业务代码直接调某家的接口，
 * 接入第二家时就要在 Service 里写 if-else。
 *
 * <p>这层接口只暴露<b>业务语义</b>（有没有号、能不能约），
 * 不暴露任何协议细节（HTTP/HL7/FHIR）。省赛用两个 Mock 实现，
 * 国赛接真实院区时新增一个实现类即可，业务层一行不改。
 *
 * <p><b>诚实声明</b>：当前没有任何真实医院接口。两个 Mock 实现
 * 用于验证"换院区不改业务代码"这件事本身，不模拟真实吞吐与时延。
 */
public interface HospitalAdapter {

    /** 这个适配器负责哪个院区（对应 hospital.hospital_code） */
    String hospitalCode();

    /**
     * 面向患者与界面的展示名，**必须带「（演示）」后缀**。
     *
     * <p>刻意和要求院方返回的字段分开：院方接口里只有编码和号源，
     * 名字是我们的展示层信息。接真实院区时由 `hospital` 表提供，
     * 但那需要连库；Mock 阶段由适配器自己给出，省掉一次无关的 IO。
     *
     * <p><b>为什么强制带「（演示）」</b>：这一栏会直接出现在号源卡片和
     * 预约列表上。用真实医院名却不标注演示，等于让患者以为
     * 真能在那个时段走进那家医院 —— 这比"名字不好看"严重得多。
     */
    String displayName();

    /**
     * 这个院区开设的科室名（与 {@link #querySlots} 认识的科室一致）。
     *
     * <p>存在的理由：AI 给出的科室建议必须能在院方侧被验证。
     * 分诊说"挂消化内科"，而这家院区根本没这个科，用户点下去才失败，
     * 体验上等同于"系统坏了"。有了这个方法，排程可以在给预览之前先筛。
     *
     * <p>返回空集合表示"院方没声明"，此时不做筛选 —— 宁可放过，不可误杀。
     */
    java.util.Set<String> departments();

    /**
     * 查询某科室的可预约号源。
     *
     * @param department 科室名
     * @param date       期望就诊日期
     * @return 号源列表；无号返回空列表，<b>不返回 null</b>
     */
    List<Slot> querySlots(String department, LocalDate date);

    /**
     * 下单。
     *
     * <p>注意返回的是 {@link BookingResult} 而不是 boolean：
     * 失败原因必须能传回给用户（"该时段已满" vs "院区接口超时"
     * 是完全不同的两件事，前者换个时间，后者该重试）。
     */
    BookingResult book(String department, LocalDateTime visitTime);

    /** 取消。幂等：重复取消同一单不应报错 */
    BookingResult cancel(String externalOrderNo);

    /**
     * 一个号源。
     *
     * @param remaining 剩余号数
     */
    record Slot(LocalDateTime visitTime, String doctorName, int remaining) {
    }

    /**
     * 下单/取消结果。
     *
     * @param ok         是否成功
     * @param externalNo 对方系统的单号，成功时非空
     * @param message    失败原因，成功时为空
     */
    record BookingResult(boolean ok, String externalNo, String message) {

        public static BookingResult ok(String externalNo) {
            return new BookingResult(true, externalNo, null);
        }

        public static BookingResult fail(String message) {
            return new BookingResult(false, null, message);
        }
    }
}
