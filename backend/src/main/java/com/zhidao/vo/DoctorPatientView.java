package com.zhidao.vo;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;

/**
 * 医生工作台的患者视图。
 *
 * <p>列表接口只需要上半部分（档案摘要 + 计数），详情接口在此基础上
 * 追加最近病历与预约。用同一个 record 承载两种形态，
 * {@code records}/{@code bookings} 在列表场景为 {@code null}；
 * 全局 {@code default-property-inclusion=non_null} 会把 null 字段直接省掉，
 * 所以列表响应里不会出现两个空数组让前端误判"这个患者没有病历"。
 *
 * <p><b>关于过敏史 / 慢病 / 用药</b>：这三份数据是患者自己维护的，
 * 医生端只读展示。它们是 JSON 数组列，这里已经解析成 {@code List<String>}，
 * 医生端不该关心我们的存储格式（同 {@code PatientController} 的做法）。
 */
public record DoctorPatientView(
        Long userId,
        String displayName,
        String gender,
        Integer age,
        List<String> allergies,
        List<String> chronics,
        List<String> medications,
        long recordCount,
        long bookingCount,
        LocalDate lastVisitDate,
        List<RecordItem> records,
        List<BookingItem> bookings
) {

    /** 病历摘要项。只给医生看列表所需的最小字段，正文不在其中 */
    public record RecordItem(
            Long id,
            LocalDate visitDate,
            String hospitalCode,
            String department,
            String diagnosisBrief
    ) {
    }

    /** 预约项。状态直接给英文枚举，前端自行翻译为"待确认 / 已确认" */
    public record BookingItem(
            Long id,
            LocalDateTime visitTime,
            String department,
            String status
    ) {
    }
}
