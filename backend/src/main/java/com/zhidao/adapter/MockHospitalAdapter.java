package com.zhidao.adapter;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Mock 院区适配器（通用实现，以院区编码和号源特征参数化）。
 *
 * <p>两个 Mock 院区共用这一个类，只在构造时传入不同的号源策略 ——
 * 这本身就是对"适配器抽象是否有用"的验证：如果两家行为不同
 * 就必须写两个类，说明抽象漏了东西。
 *
 * <p>刻意保留的差异（用来演示跨院对比的价值）：
 * <ul>
 *   <li>MOCK-A 内分泌科号源紧俏（当天基本约不到）</li>
 *   <li>MOCK-B 内分泌科号源宽松，但心血管内科偏紧</li>
 * </ul>
 * 这样"换个院区就能约到"的演示才成立，而不是两家完全一样。
 */
@Slf4j
public class MockHospitalAdapter implements HospitalAdapter {

    private final String hospitalCode;
    private final String displayName;

    /** 已下的单：externalNo -> 就诊时间。内存存储，重启即清空 */
    private final Map<String, LocalDateTime> orders = new ConcurrentHashMap<>();
    private final AtomicLong seq = new AtomicLong(1000);

    /**
     * 号源松紧度：科室 -> 每天放几个号。
     * 这是一个粗糙的模型，够用来演示"换个院区有号"。
     */
    private final Map<String, Integer> dailyQuota;

    public MockHospitalAdapter(String hospitalCode, String displayName, Map<String, Integer> dailyQuota) {
        this.hospitalCode = hospitalCode;
        this.displayName = displayName;
        this.dailyQuota = dailyQuota;
    }

    @Override
    public String hospitalCode() {
        return hospitalCode;
    }

    @Override
    public List<Slot> querySlots(String department, LocalDate date) {
        int quota = dailyQuota.getOrDefault(department, 0);
        if (quota <= 0) {
            return List.of();
        }

        List<Slot> slots = new ArrayList<>();
        // 半天放一半号，上午 8:30 起每 30 分钟一个
        LocalTime start = LocalTime.of(8, 30);
        for (int i = 0; i < quota; i++) {
            LocalDateTime t = LocalDateTime.of(date, start.plusMinutes(30L * i));
            slots.add(new Slot(t, "演示医生" + (char) ('A' + (i % 3)), 1));
        }
        return slots;
    }

    @Override
    public BookingResult book(String department, LocalDateTime visitTime) {
        // 先看这个时段是否真的在号源里 —— 不允许绕过号源直接下单
        boolean available = querySlots(department, visitTime.toLocalDate()).stream()
                .anyMatch(s -> s.visitTime().equals(visitTime));
        if (!available) {
            return BookingResult.fail(displayName + " 该时段没有可预约的号源");
        }

        // 同一时段只允许一个人下单（Mock 的并发控制，真实系统由对方保证）
        boolean taken = orders.containsValue(visitTime);
        if (taken) {
            return BookingResult.fail("该时段已被占用，请换一个时间");
        }

        String externalNo = hospitalCode + "-" + seq.incrementAndGet();
        orders.put(externalNo, visitTime);
        log.debug("Mock 下单成功 {} {} {}", hospitalCode, department, externalNo);
        return BookingResult.ok(externalNo);
    }

    @Override
    public BookingResult cancel(String externalOrderNo) {
        if (externalOrderNo == null || externalOrderNo.isBlank()) {
            return BookingResult.fail("单号为空");
        }
        // 幂等：不存在也视为成功，因为"取消后它确实不在了"是用户要的结果
        orders.remove(externalOrderNo);
        return BookingResult.ok(externalOrderNo);
    }
}
