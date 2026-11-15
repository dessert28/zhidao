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

        /*
         * 号源模型：每天 quota 个时段，每个时段可接 SLOT_CAPACITY 人。
         *
         * 原来是"每个时段 1 个号"，那等于一个时段只能约一个人 ——
         * 做排队估算时立刻暴露问题：同一时段第二个人直接 409，
         * "前面还有几个人"永远算不出来，估算功能形同虚设。
         *
         * 真实门诊也是这个样子：医生半天看 20-40 个号，
         * 按 30 分钟分时段，每个时段接好几位，只是预约时
         * 具体排在第几个由到场顺序决定。所以容量改成 3，
         * 既让排队估算有意义，也让"同一时段有人在你前面"成为可能。
         */
        /*
         * 号源覆盖全天门诊时段：上午 8:30-11:30、下午 14:00-16:30。
         *
         * 原来只有上午 8:30 起的几个时段，实测发现一个实际问题：
         * 下午打开应用的患者永远看到"号源都已过去"，
         * 排队估算也就永远是"无法估算"——功能等于没用。
         *
         * 真实门诊确实是上下午都有号。按 quota 在上午/下午之间分配，
         * quota 是奇数时上午多一个（上午号通常更抢手，也符合直觉）。
         */
        List<Slot> slots = new ArrayList<>();
        int morning = (quota + 1) / 2;
        int afternoon = quota / 2;

        LocalTime morningStart = LocalTime.of(8, 30);
        for (int i = 0; i < morning; i++) {
            LocalDateTime t = LocalDateTime.of(date, morningStart.plusMinutes(30L * i));
            slots.add(new Slot(t, "演示医生" + (char) ('A' + (i % 3)), SLOT_CAPACITY));
        }
        LocalTime afternoonStart = LocalTime.of(14, 0);
        for (int i = 0; i < afternoon; i++) {
            LocalDateTime t = LocalDateTime.of(date, afternoonStart.plusMinutes(30L * i));
            slots.add(new Slot(t, "演示医生" + (char) ('A' + (i % 3)), SLOT_CAPACITY));
        }
        return slots;
    }

    /** 每个时段的接诊容量。见 querySlots 的说明 */
    private static final int SLOT_CAPACITY = 3;

    @Override
    public BookingResult book(String department, LocalDateTime visitTime) {
        // 先看这个时段是否真的在号源里 —— 不允许绕过号源直接下单
        boolean available = querySlots(department, visitTime.toLocalDate()).stream()
                .anyMatch(s -> s.visitTime().equals(visitTime));
        if (!available) {
            return BookingResult.fail(displayName + " 该时段没有可预约的号源");
        }

        /*
         * 时段容量控制。
         *
         * 原来这里是 `orders.containsValue(visitTime)` —— 只要有一个人约了
         * 这个时段就拒绝其他人，等于每时段容量 1。
         * 改成按容量计数：已有 N 人 < SLOT_CAPACITY 就还能约。
         *
         * 注意 Mock 的 orders 是进程内 Map，重启就清空；
         * 跨进程/跨实例的真实容量得由院方保证（docs/08 §5 已说明）。
         */
        long takenAtSlot = orders.values().stream().filter(v -> v.equals(visitTime)).count();
        if (takenAtSlot >= SLOT_CAPACITY) {
            return BookingResult.fail("该时段号源已满，请换一个时间");
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
