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
