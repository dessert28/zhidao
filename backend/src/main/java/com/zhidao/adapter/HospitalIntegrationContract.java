package com.zhidao.adapter;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 院方接入契约 —— 给医院信息科看的接口说明书。
 *
 * <p>为什么做成代码而不是只写在 md 里：
 * <ul>
 *   <li>对接方通常拿不到我们的仓库，但他们能打开一个 URL</li>
 *   <li>写在这里就能<strong>和 {@link HospitalAdapter} 一起编译</strong> ——
 *       接口改了而文档忘了改，是这类文档最常见的失效方式。
 *       改方法签名时编译器会逼着这里同步</li>
 *   <li>前端可以把这个结构直接渲染成页面，不用再维护一份</li>
 * </ul>
 *
 * <p>它描述的是<strong>院方要实现的那些端点</strong>（HTTP JSON），
 * 而不是我们内部的方法。院方按这份说明做出接口后，
 * 我们写一个 {@code HttpHospitalAdapter} 去调它，
 * 以后加一家医院只是改配置里的 baseUrl。
 */
public final class HospitalIntegrationContract {

    private HospitalIntegrationContract() {
    }

    /** 契约版本。院方对接时带在联调记录里，我们改字段时会升版本 */
    public static final String VERSION = "1.0";

    /**
     * 完整契约。
     *
     * <p>结构刻意保持扁平（endpoints / fields / errors / notes 四段），
     * 前端能直接遍历渲染，不需要为它写专门的解析逻辑。
     */
    public static Map<String, Object> describe() {
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("version", VERSION);
        root.put("summary", "智诊通院区接入契约：院方提供 4 个 HTTP JSON 端点，"
                + "我们据此完成号源查询、下单、取消与科室目录。");
        root.put("auth", auth());
        root.put("endpoints", endpoints());
        root.put("errors", errors());
        root.put("notes", notes());
        return root;
    }

    /* ============================ 认证 ============================ */

    private static Map<String, Object> auth() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("scheme", "HMAC-SHA256 请求签名（与 /api/his/* 已有的 HIS 对接方式一致）");
        m.put("headers", List.of(
                header("X-App-Key", "院方与平台约定的应用标识"),
                header("X-Timestamp", "毫秒时间戳。与服务端相差超过 5 分钟即拒绝，防重放"),
                header("X-Signature", "HMAC-SHA256(appSecret, appKey + timestamp + body) 的十六进制小写"),
                header("Content-Type", "application/json; charset=utf-8")
        ));
        m.put("note", "演示阶段用 Mock 适配器，不校验签名；真实接入时强制启用。");
        return m;
    }

    private static Map<String, Object> header(String name, String desc) {
        Map<String, Object> h = new LinkedHashMap<>();
        h.put("name", name);
        h.put("desc", desc);
        return h;
    }

    /* ============================ 端点 ============================ */

    private static List<Map<String, Object>> endpoints() {
        List<Map<String, Object>> list = new ArrayList<>();
        list.add(departmentsEndpoint());
        list.add(slotsEndpoint());
        list.add(bookEndpoint());
        list.add(cancelEndpoint());
        return list;
    }

    /**
     * 1) 科室目录。
     *
     * <p>为什么必须有它：AI 会推荐科室，如果推荐了一个该院根本没开的科，
     * 用户点下去才发现没号 —— 那不是"没号"，那是系统在瞎说。
     * 有了这个端点，我们能在给出建议之前先核对一遍。
     */
    private static Map<String, Object> departmentsEndpoint() {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("id", "departments");
        e.put("name", "科室目录");
        e.put("method", "GET");
        e.put("path", "/departments");
        e.put("purpose", "院区开设的科室列表。用于在推荐科室前核对，避免推荐不存在的科。");
        e.put("requestParams", List.of());

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("code", field("int", true, "0 表示成功，其他为业务错误码"));
        resp.put("message", field("string", true, "错误说明，成功时为 ok"));
        resp.put("data", List.of(
                item("code", "string", true, "科室编码，院方内部编码即可，需在号源接口里一致"),
                item("name", "string", true, "科室标准名，如「心血管内科」。别用简称"),
                item("aliases", "string[]", false, "口语别名，如 [\"心内科\",\"心脏科\"]，用于提升匹配率"),
                item("enabled", "boolean", false, "该科是否开放预约，缺省视为 true")
        ));
        e.put("response", resp);
        e.put("example", example(Map.of("code", 0, "message", "ok", "data", List.of(
                Map.of("code", "D0101", "name", "心血管内科",
                        "aliases", List.of("心内科", "心脏科"), "enabled", true),
                Map.of("code", "D0201", "name", "内分泌科",
                        "aliases", List.of("糖尿病科"), "enabled", true)
        ))));
        return e;
    }

    /**
     * 2) 号源查询 —— 整条链路最核心的一个。
     *
     * <p>日期维度：按"科室 + 一天"查。不按周/月批量查，
     * 因为患者一次只看一天；批量接口会把院方的号表压力抬一个量级。
     */
    private static Map<String, Object> slotsEndpoint() {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("id", "slots");
        e.put("name", "号源查询");
        e.put("method", "GET");
        e.put("path", "/slots");
        e.put("purpose", "查某科室某天的可预约时段。这是挂号页和对话里「有没有号」的唯一数据来源。");

        e.put("requestParams", List.of(
                param("date", "string", true, "就诊日期，格式 YYYY-MM-DD，按院区所在地时区"),
                param("department", "string", true, "科室编码或标准名，与 /departments 返回的一致"),
                param("departmentName", "string", false, "科室标准名。当院方只用编码时可不传")
        ));

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("code", "int");
        resp.put("message", "string");
        resp.put("data", List.of(
                item("visitTime", "string", true, "就诊时间，格式 YYYY-MM-DDTHH:mm:ss"),
                item("doctorName", "string", false, "医生姓名或「职称·姓名」；不提供姓名时给「普通门诊」"),
                item("doctorTitle", "string", false, "职称，如 主任医师。界面用于区分专家号/普通号"),
                item("fee", "number", false, "挂号费（元）。不提供时不展示价格"),
                item("remaining", "int", true, "剩余号数。0 表示已满，仍须返回该时段而不是省略"),
                item("extCode", "string", false, "院方时段唯一编码，下单时原样回传。有它就一定用")
        ));
        e.put("response", resp);
        e.put("example", example(Map.of("code", 0, "message", "ok", "data", List.of(
                Map.of("visitTime", "2026-11-17T08:30:00", "doctorName", "王医生",
                        "doctorTitle", "主任医师", "fee", 50, "remaining", 3, "extCode", "S-20261117-0830-01"),
                Map.of("visitTime", "2026-11-17T09:00:00", "doctorName", "普通门诊",
                        "remaining", 0, "extCode", "S-20261117-0900-01")
        ))));

        Map<String, Object> rules = new LinkedHashMap<>();
        rules.put("emptyResult", "当天没号返回 data: []，不要用错误码表示「没号」——那是正常结果");
        rules.put("pastSlots", "已过去的时段不要返回。我们也会再过滤一次，但院方过滤更准");
        rules.put("remaining", "必须反映实时余量；号被其他渠道占掉后剩余数要跟着变");
        e.put("rules", rules);
        return e;
    }

    /**
     * 3) 下单。
     *
     * <p>幂等要求：同一个 requestId 重复提交不能占两次号。
     * 网络超时后我们会重试，没有幂等键的重试等于双重下单。
     */
    private static Map<String, Object> bookEndpoint() {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("id", "book");
        e.put("name", "下单");
        e.put("method", "POST");
        e.put("path", "/bookings");
        e.put("purpose", "占号并生成院方预约单。");

        e.put("requestParams", List.of(
                param("requestId", "string", true, "幂等键，由我们生成（UUID）。重复提交必须返回同一单"),
                param("department", "string", true, "科室编码"),
                param("visitTime", "string", true, "就诊时间，须与号源接口返回的一致"),
                param("extCode", "string", false, "号源接口给的时段编码，有则优先使用"),
                param("patient", "object", true, "患者信息（见 patient 字段说明）")
        ));

        Map<String, Object> reqResp = new LinkedHashMap<>();
        reqResp.put("patient.name", "string 姓名。脱敏后可能为占位符，见 rules.identity");
        reqResp.put("patient.idNo", "string 证件号（加密传输）");
        reqResp.put("patient.phone", "string 手机号");
        reqResp.put("patient.insuranceType", "string 医保类型，如 职工医保 / 自费");
        e.put("requestFields", reqResp);

        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("code", "int");
        resp.put("message", "string");
        resp.put("data", List.of(
                item("orderNo", "string", true, "院方订单号，患者取号/退号时使用"),
                item("visitTime", "string", true, "确认的就诊时间"),
                item("department", "string", true, "确认的科室"),
                item("status", "string", true, "CREATED / CONFIRMED"),
                item("pickupCode", "string", false, "取号码或排队号，有则展示给患者")
        ));
        e.put("response", resp);
        e.put("example", example(Map.of("code", 0, "message", "ok", "data", Map.of(
                "orderNo", "H2-20261117-1024", "visitTime", "2026-11-17T08:30:00",
                "department", "内分泌科", "status", "CONFIRMED", "pickupCode", "A032"
        ))));
        return e;
    }

    /**
     * 4) 取消。幂等。
     */
    private static Map<String, Object> cancelEndpoint() {
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("id", "cancel");
        e.put("name", "取消");
        e.put("method", "POST");
        e.put("path", "/bookings/{orderNo}/cancel");
        e.put("purpose", "退号。号要回到池子里，否则会被永久占住。");
        e.put("requestParams", List.of(
                param("orderNo", "string", true, "院方订单号，放在路径里"),
                param("reason", "string", false, "退号原因，如 患者主动取消 / 重复挂号")
        ));
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("code", "int");
        resp.put("message", "string");
        resp.put("data", Map.of("cancelled", "boolean 是否取消成功"));
        e.put("response", resp);
        e.put("example", example(Map.of("code", 0, "message", "ok", "data", Map.of("cancelled", true))));
        e.put("rules", Map.of(
                "idempotent", "重复取消同一单必须返回成功，不能报错",
                "lateCancel", "过了退号截止时间：返回业务错误码并说明，不要静默失败"
        ));
        return e;
    }

    /* ============================ 错误码 ============================ */

    /**
     * 错误码约定。
     *
     * <p>关键在于<strong>「号已满」和「接口异常」必须分开</strong>：
     * 前者让患者换个时间，后者该重试。合成一句"下单失败"，
     * 用户不知道该做什么，我们也无法判断要不要重试。
     */
    private static List<Map<String, Object>> errors() {
        List<Map<String, Object>> list = new ArrayList<>();
        list.add(err(0, "OK", "成功"));
        list.add(err(1001, "DEPARTMENT_NOT_FOUND", "科室不存在或未开放预约。患者该换科室"));
        list.add(err(1002, "SLOT_NOT_FOUND", "时段不存在或已过期。患者该刷新号源"));
        list.add(err(1003, "SLOT_FULL", "该时段号已满。患者该换时间，不该重试"));
        list.add(err(1004, "PATIENT_NOT_ELIGIBLE", "患者不满足该科的预约条件（如限复诊、限本地医保）"));
        list.add(err(1005, "DUPLICATE_BOOKING", "同一患者同期已有该科预约。返回已有单号"));
        list.add(err(1006, "CANCEL_WINDOW_CLOSED", "已过退号截止时间"));
        list.add(err(2001, "UNAUTHORIZED", "签名校验失败或 AppKey 无效"));
        list.add(err(5000, "INTERNAL_ERROR", "院方系统内部错误。我们按可重试处理"));
        return list;
    }

    private static Map<String, Object> err(int code, String name, String desc) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("code", code);
        m.put("name", name);
        m.put("desc", desc);
        return m;
    }

    /* ============================ 通用说明 ============================ */

    private static List<String> notes() {
        return List.of(
                "时间格式统一 YYYY-MM-DDTHH:mm:ss，不做时区后缀，按院区所在地时区理解。",
                "所有响应使用同一个信封 {code, message, data}，与平台其他接口一致。",
                "号源是实时数据：我们不做本地缓存，每次查询都会打到院方。请评估并告知每日峰值 QPS。",
                "「没号」是正常结果（data 为空数组），不要用错误码表达，否则会被当成服务故障。",
                "下单必须支持幂等键 requestId：网络超时我们会重试，重复占号不可接受。",
                "患者身份：平台传输的姓名/证件号可能是脱敏后的占位符（隐私架构要求），"
                        + "院方如需真实身份，应在自己的医保/就诊卡体系内通过患者本人完成核验。",
                "演示环境使用 Mock 适配器，所有号源、医生、楼层均为示意数据，并在界面标注「（演示）」。"
        );
    }

    /* ============================ 工具 ============================ */

    private static Map<String, Object> field(String type, boolean required, String desc) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", type);
        m.put("required", required);
        m.put("desc", desc);
        return m;
    }

    private static Map<String, Object> param(String name, String type, boolean required, String desc) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", name);
        m.put("type", type);
        m.put("required", required);
        m.put("desc", desc);
        return m;
    }

    private static Map<String, Object> item(String name, String type, boolean required, String desc) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", name);
        m.put("type", type);
        m.put("required", required);
        m.put("desc", desc);
        return m;
    }

    private static Map<String, Object> example(Object data) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("json", data);
        return m;
    }

    /**
     * 供联调自查用的一组示例请求。
     *
     * <p>院方实现完接口后，照着这几个请求打一遍，
     * 能覆盖「有号 / 没号 / 号满 / 重复提交」四类最容易出错的情况。
     */
    public static List<Map<String, Object>> smokeTests() {
        return List.of(
                smoke("departments", "GET", "/departments", null, "应返回至少一个科室"),
                smoke("slots", "GET", "/slots?date=" + LocalDate.now() + "&department=D0201", null,
                        "正常应返回数组；没号应为空数组而不是报错"),
                smoke("slots-bad-dept", "GET", "/slots?date=" + LocalDate.now() + "&department=NOT_EXIST", null,
                        "应返回 1001，而不是 500"),
                smoke("book", "POST", "/bookings",
                        "{\"requestId\":\"test-uuid-1\",\"department\":\"D0201\",\"visitTime\":\""
                                + LocalDate.now().plusDays(1) + "T09:00:00\",\"patient\":{\"name\":\"测试\"}}",
                        "重复提交同一 requestId 应返回同一 orderNo（幂等）"),
                smoke("cancel", "POST", "/bookings/{orderNo}/cancel", "{\"reason\":\"联调测试\"}",
                        "重复取消应仍返回成功")
        );
    }

    private static Map<String, Object> smoke(
            String id, String method, String path, String body, String expect) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("method", method);
        m.put("path", path);
        m.put("body", body);
        m.put("expect", expect);
        return m;
    }

    /** 时间格式提示，避免院方各自发挥 */
    public static String timestampExample() {
        return LocalDateTime.now().withSecond(0).withNano(0).toString();
    }
}
