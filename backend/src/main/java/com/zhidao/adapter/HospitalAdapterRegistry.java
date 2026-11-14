package com.zhidao.adapter;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 院区适配器注册表。
 *
 * <p>存在的理由只有一个：<b>让业务层不认识任何一家医院</b>。
 * Service 拿到 {@code hospitalCode} 后调 {@link #of(String)}，
 * 具体是哪家、走的什么协议，都不会出现在业务代码里。
 *
 * <p>手工注册而不是 {@code @Component} 自动收集：
 * Spring 会把所有 {@link HospitalAdapter} 实现塞进一个 List，
 * 顺序取决于扫描顺序（不稳定），而且 MOCK-A / MOCK-B 共用同一个实现类，
 * 无法靠注解区分。用工厂方法显式声明，加一家新院区就在这一个地方加一行。
 *
 * <p><b>诚实声明</b>：这里只有两个 Mock。接真实院区需要资质与商务流程，
 * 架构预留了位置，但当前没有任何真实接口（docs/08 §5）。
 */
@Slf4j
@Component
public class HospitalAdapterRegistry {

    private final Map<String, HospitalAdapter> adapters = new LinkedHashMap<>();

    public HospitalAdapterRegistry() {
        // MOCK-A 内分泌科号源紧俏，心血管科宽松
        register(new MockHospitalAdapter("MOCK-A", "演示市第一人民医院（示例）", Map.of(
                "内分泌科", 2,
                "心血管内科", 3,
                "神经内科", 3
        )));
        // MOCK-B 反过来：内分泌科宽松，心血管科紧俏
        // 两家不一样，"换个院区就能约到"的演示才成立
        register(new MockHospitalAdapter("MOCK-B", "演示市中心医院（示例）", Map.of(
                "内分泌科", 4,
                "心血管内科", 1,
                "骨科", 2
        )));
    }

    public void register(HospitalAdapter adapter) {
        adapters.put(adapter.hospitalCode(), adapter);
        log.info("注册院区适配器: {}", adapter.hospitalCode());
    }

    /** 找不到返回 empty —— 由调用方决定是报错还是降级，不在这里替它决定 */
    public Optional<HospitalAdapter> find(String hospitalCode) {
        return Optional.ofNullable(adapters.get(hospitalCode));
    }

    /**
     * 取适配器，取不到直接失败。
     *
     * <p>为什么这里硬失败而不是降级：院区编码不存在意味着请求本身是错的
     * （前端传错了或数据脏了）。悄悄换成另一家院区，用户会约到自己没想到的地方。
     */
    public HospitalAdapter of(String hospitalCode) {
        return find(hospitalCode).orElseThrow(() ->
                new com.zhidao.common.BizException("院区不存在或暂未接入：" + hospitalCode));
    }

    /** 已接入的院区编码，供接口展示用 */
    public List<String> codes() {
        return List.copyOf(adapters.keySet());
    }
}
