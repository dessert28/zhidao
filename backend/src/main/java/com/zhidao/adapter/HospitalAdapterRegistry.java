package com.zhidao.adapter;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
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
 * 顺序取决于扫描顺序（不稳定），而且多个演示院区共用同一个实现类，
 * 无法靠注解区分。用工厂方法显式声明，加一家新院区就在这一个地方加一行。
 *
 * <h3>为什么只有一个院区</h3>
 *
 * <p>上一版有 MOCK-A / MOCK-B / Z2-JFL 三家，其中两家叫
 * 「演示市第一人民医院」「演示市中心医院」—— 这种名字对评审和患者
 * 都没有信息量：它既不像真实医院，也不说明自己在演示什么。
 *
 * <p>现在只保留<b>一家</b>用真实名称的演示院区（浙大二院解放路院区），
 * 名字后面强制带「（演示）」。这比堆三家假医院诚实，也更能让人看懂
 * 我们要解决的是哪一家的就诊流程。
 *
 * <h3>院方接入怎么做</h3>
 *
 * <p>接入一家真实医院 = 新写一个 {@link HospitalAdapter} 实现 + 在这里
 * {@code register(...)} 一行。业务层（BookingService、排程 Agent、
 * 提醒引擎）一行都不用改。需要院方提供的字段见
 * {@link #integrationRequirements()} —— 那份清单同时通过
 * {@code GET /api/bookings/hospitals} 暴露给前端，院方对接时按它准备。
 *
 * <p><b>诚实声明</b>：当前没有任何真实医院接口。这里注册的院区
 * 号源、医生、放号节奏全部是示意数据（{@link HospitalAdapter#displayName()}
 * 带「演示」两种角标），真实接入需要资质与商务流程（docs/08 §5）。
 */
@Slf4j
@Component
public class HospitalAdapterRegistry {

    /** 演示院区的编码。常量而不是散落的字符串：前端、BFF、后端都要用同一个 */
    public static final String DEMO_CODE = "Z2-JFL";

    private final Map<String, HospitalAdapter> adapters = new LinkedHashMap<>();

    public HospitalAdapterRegistry() {
        /*
         * 浙大二院解放路院区。
         *
         * 用真实医院名 + 「（演示）」后缀，而不是"MOCK-C"：
         * "跨院"叙事需要一家可识别的三甲做样例，抽象成"演示市第 N 人民医院"
         * 会让评审感知不到真实场景；但完全不加标注则更糟 —— 患者会以为
         * 真能在那个时段走进那家医院。两个要求同时满足的唯一写法就是
         * 真名 + 演示角标。
         *
         * 号源分布（示意数据，但刻意做了科室差异）：
         *   · 心血管内科、神经内科放号多 —— 老年人最常见的两类
         *   · 消化内科、骨科居中
         *   · 皮肤科最少 —— 用来演示"没号时怎么办"
         */
        register(new MockHospitalAdapter(
                DEMO_CODE,
                "浙江大学医学院附属第二医院（解放路院区）（演示）",
                new LinkedHashMap<>(Map.of(
                        "心血管内科", 4,
                        "神经内科", 4,
                        "内分泌科", 3,
                        "消化内科", 3,
                        "骨科", 2,
                        "皮肤科", 1,
                        "全科医学科", 3
                ))));
    }

    public void register(HospitalAdapter adapter) {
        adapters.put(adapter.hospitalCode(), adapter);
        log.info("注册院区适配器: {} {}", adapter.hospitalCode(), adapter.displayName());
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

    /** 已接入的院区（编码 + 展示名 + 科室），供前端渲染选择器 */
    public List<Map<String, Object>> catalogs() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (HospitalAdapter a : adapters.values()) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("code", a.hospitalCode());
            m.put("name", a.displayName());
            m.put("departments", a.departments());
            out.add(m);
        }
        return out;
    }

    /**
     * 院方接入清单。
     *
     * <p>这不是装饰性文档：它和 {@link HospitalAdapter} 的方法一一对应，
     * 院方照着准备，接入就是"实现一个类"而不是"联调三个月"。
     *
     * <p>放在接口里返回而不是只写进 md，是因为对接方通常是医院信息科，
     * 他们打开 {@code GET /api/bookings/hospitals} 就能看到要准备什么，
     * 不用先找到我们的仓库。
     */
    public static List<Map<String, String>> integrationRequirements() {
        return List.of(
                Map.of("field", "hospitalCode", "desc", "院区唯一编码，跨院数据以它为准，不做外键"),
                Map.of("field", "displayName", "desc", "对外展示名，需院方确认；演示环境必须带（演示）"),
                Map.of("field", "departments", "desc", "院区开设的科室名，需与号源表一致"),
                Map.of("field", "querySlots", "desc", "按科室+日期查号源：时段、医生、剩余号数；无号返回空列表"),
                Map.of("field", "book", "desc", "下单：返回院方单号；失败必须区分「已满」与「接口异常」"),
                Map.of("field", "cancel", "desc", "取消：按院方单号，幂等，重复取消不报错")
        );
    }
}
