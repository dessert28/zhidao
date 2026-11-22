package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.zhidao.entity.BookingOrder;
import com.zhidao.entity.Hospital;
import com.zhidao.entity.HospitalPlace;
import com.zhidao.entity.MedicalRecord;
import com.zhidao.entity.SysNotice;
import com.zhidao.entity.SysUser;
import com.zhidao.mapper.BookingOrderMapper;
import com.zhidao.mapper.HospitalMapper;
import com.zhidao.mapper.HospitalPlaceMapper;
import com.zhidao.mapper.MedicalRecordMapper;
import com.zhidao.mapper.SysNoticeMapper;
import com.zhidao.mapper.SysUserMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 管理端统计。
 *
 * <p>全部用 {@code QueryWrapper} + {@code selectMaps}/{@code selectCount}，
 * 不写 XML：这些查询都是一次聚合，放 XML 里既不比 Java 清晰，
 * 又多一份需要跟着实体字段改的维护面。
 *
 * <p><b>逻辑删除由插件统一处理</b>：聚合查询同样会被追加 {@code deleted = 0}。
 * 这里不做也不该做手工过滤 —— 一旦有人漏写一处，
 * 统计数字就会把已删除的用户/病历算进去，而这种偏差没人会对账。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AdminStatsService {

    /** 趋势图最多看 90 天。更多天数在屏幕上已经看不清，且会把返回体撑大 */
    private static final int MAX_TREND_DAYS = 90;

    /** 科室分布只取前 8：饼图放不下更多，剩下的合并成"其他"反而更清楚 */
    private static final int DEPARTMENT_TOP_N = 8;

    private final SysUserMapper userMapper;
    private final HospitalMapper hospitalMapper;
    private final HospitalPlaceMapper placeMapper;
    private final BookingOrderMapper bookingMapper;
    private final MedicalRecordMapper recordMapper;
    private final SysNoticeMapper noticeMapper;

    /**
     * 全院口径的概览（兼容无参调用）。
     *
     * <p>保留这个重载是刻意的：管理端早期只有"全院管理员"一种视角，
     * 现有调用方不该因为新增了院区筛选就被迫改签名。
     */
    public Overview overview() {
        return overview(null);
    }

    /**
     * 首页概览。
     *
     * <p>十项数字一次返回，而不是让前端并行发十个请求：
     * 概览页打开时十个请求里任何一个慢，整页都在等；
     * 而它们本来就该是同一时刻的快照 —— 分开查会出现
     * "用户数已经变了、预约数还是旧的"这种自相矛盾的画面。
     *
     * <p><b>院区口径只说一半的话会误导人</b>，所以这里按字段分别说明：
     * <ul>
     *   <li>院区数 / 院内地点 / 预约 / 病历 / 今日预约 —— 跟着 hospitalCode 走，
     *       筛了单院区就只算这一个院区；</li>
     *   <li>用户四项 + 公告条数 —— <b>永远是全院</b>。{@code sys_user} 与
     *       {@code sys_notice} 都没有院区字段，硬拿一个院区去过滤它们只能编一个
     *       假口径出来。前端必须把这点写在界面上，否则"单院区视角下还有 5 个患者"
     *       会被读成"这个院区有 5 个患者"。</li>
     * </ul>
     */
    public Overview overview(String hospitalCode) {
        String code = normalizeCode(hospitalCode);
        LocalDate today = LocalDate.now();
        LocalDateTime dayStart = today.atStartOfDay();
        LocalDateTime dayEnd = today.plusDays(1).atStartOfDay();

        long hospitalCount;
        if (code == null) {
            hospitalCount = count(hospitalMapper.selectCount(null));
        } else {
            // 筛单院区时"院区数"只能是 1 或 0（编码不存在），
            // 不能返回全表数量 —— 那会让"院区数 2"和单院区标题同时出现
            hospitalCount = count(hospitalMapper.selectCount(new LambdaQueryWrapper<Hospital>()
                    .eq(Hospital::getHospitalCode, code))) > 0 ? 1L : 0L;
        }

        return new Overview(
                count(userMapper.selectCount(null)),
                count(userMapper.selectCount(new LambdaQueryWrapper<SysUser>()
                        .eq(SysUser::getRole, "PATIENT"))),
                count(userMapper.selectCount(new LambdaQueryWrapper<SysUser>()
                        .eq(SysUser::getRole, "DOCTOR"))),
                count(userMapper.selectCount(new LambdaQueryWrapper<SysUser>()
                        .eq(SysUser::getRole, "ADMIN"))),
                hospitalCount,
                count(placeMapper.selectCount(new LambdaQueryWrapper<HospitalPlace>()
                        .eq(code != null, HospitalPlace::getHospitalCode, code))),
                count(bookingMapper.selectCount(new LambdaQueryWrapper<BookingOrder>()
                        .eq(code != null, BookingOrder::getHospitalCode, code))),
                count(recordMapper.selectCount(new LambdaQueryWrapper<MedicalRecord>()
                        .eq(code != null, MedicalRecord::getHospitalCode, code))),
                count(noticeMapper.selectCount(null)),
                count(bookingMapper.selectCount(new LambdaQueryWrapper<BookingOrder>()
                        .eq(code != null, BookingOrder::getHospitalCode, code)
                        .ge(BookingOrder::getVisitTime, dayStart)
                        .lt(BookingOrder::getVisitTime, dayEnd))));
    }

    /**
     * 近 N 天预约趋势。
     *
     * <p><b>必须把没有预约的日期补成 0</b>：折线图拿到
     * {@code [{11-10:3},{11-13:1}]} 会把 11-10 直接连到 11-13，
     * 看起来像"这三天各有一单"。连续日期由 Java 侧补齐 ——
     * 用 SQL 生成日期序列在 H2 和 MySQL 里写法不同，
     * 而这段补零逻辑与数据库无关。
     */
    public List<TrendPoint> bookingsTrend(int days) {
        return bookingsTrend(days, null);
    }

    /**
     * 近 N 天预约趋势（可按院区收敛）。
     *
     * <p>院区条件加在 {@code where} 里而不是查完全表再在 Java 过滤：
     * 趋势图是按天聚合的，先聚合再过滤会让"这段时间院里很闲"变成
     * "看着很忙但被筛掉了"，两边都错。
     */
    public List<TrendPoint> bookingsTrend(int days, String hospitalCode) {
        int n = Math.min(MAX_TREND_DAYS, Math.max(1, days));
        LocalDate today = LocalDate.now();
        LocalDate start = today.minusDays(n - 1L);
        String code = normalizeCode(hospitalCode);

        /*
         * 按天聚合用 CAST(... AS DATE)：MySQL 与 H2（MODE=MySQL）都支持，
         * 而 DATE() / DATE_FORMAT() 这类函数两边方言不一致。
         */
        QueryWrapper<BookingOrder> qw = new QueryWrapper<BookingOrder>()
                .select("CAST(visit_time AS DATE) AS visit_day", "COUNT(*) AS cnt")
                .eq(code != null, "hospital_code", code)
                .ge("visit_time", start.atStartOfDay())
                .lt("visit_time", today.plusDays(1).atStartOfDay())
                .groupBy("CAST(visit_time AS DATE)");

        Map<LocalDate, Long> byDay = new HashMap<>();
        for (Map<String, Object> row : bookingMapper.selectMaps(qw)) {
            LocalDate day = toLocalDate(pick(row, "visit_day"));
            if (day != null) {
                byDay.merge(day, longOf(pick(row, "cnt")), Long::sum);
            }
        }

        List<TrendPoint> points = new ArrayList<>(n);
        for (LocalDate d = start; !d.isAfter(today); d = d.plusDays(1)) {
            // 日期直接给 ISO 字符串：前端图表库按字符串分类轴最省事，
            // 也避免 LocalDate 在不同序列化配置下变成数组或带时区时间
            points.add(new TrendPoint(d.toString(), byDay.getOrDefault(d, 0L)));
        }
        return points;
    }

    /**
     * 科室分布：预约科室 + 病历科室合并计数。
     *
     * <p>为什么合并：只看预约会漏掉"患者自己上传病历"里的科室，
     * 只看病历又看不到还没就诊的预约。两个口径相加，
     * 更接近"这个科室有多忙"。
     */
    public List<NameValue> departments() {
        return departments(null);
    }

    public List<NameValue> departments(String hospitalCode) {
        String code = normalizeCode(hospitalCode);
        Map<String, Long> merged = new LinkedHashMap<>();
        collectDepartmentCounts(bookingMapper.selectMaps(new QueryWrapper<BookingOrder>()
                .select("department AS dept_name", "COUNT(*) AS cnt")
                .eq(code != null, "hospital_code", code)
                .isNotNull("department")
                .ne("department", "")
                .groupBy("department")), merged);
        collectDepartmentCounts(recordMapper.selectMaps(new QueryWrapper<MedicalRecord>()
                .select("department AS dept_name", "COUNT(*) AS cnt")
                .eq(code != null, "hospital_code", code)
                .isNotNull("department")
                .ne("department", "")
                .groupBy("department")), merged);

        return merged.entrySet().stream()
                .sorted(Map.Entry.<String, Long>comparingByValue().reversed())
                .limit(DEPARTMENT_TOP_N)
                .map(e -> new NameValue(e.getKey(), e.getValue()))
                .toList();
    }

    /**
     * 角色分布。
     *
     * <p><b>不接受院区参数</b>：{@code sys_user} 没有院区字段，管理员/医生都不是
     * "属于某个院区"的实体。给它加一个被忽略的参数比不加更糟 ——
     * 前端会以为筛选生效了，看到的却是全院数字。
     *
     * <p>name 直接给英文枚举（PATIENT / DOCTOR / ADMIN），中文在前端翻译：
     * 服务端一旦开始返回展示文案，多语言和文案调整就都要发后端版本。
     */
    public List<NameValue> roles() {
        List<NameValue> list = new ArrayList<>();
        for (Map<String, Object> row : userMapper.selectMaps(new QueryWrapper<SysUser>()
                .select("role AS role_name", "COUNT(*) AS cnt")
                .groupBy("role"))) {
            Object name = pick(row, "role_name");
            if (name != null) {
                list.add(new NameValue(String.valueOf(name), longOf(pick(row, "cnt"))));
            }
        }
        // 数量相同（比如各 1 个）时按名称排，保证图例顺序稳定
        list.sort(Comparator.comparingLong(NameValue::value).reversed()
                .thenComparing(NameValue::name));
        return list;
    }

    /* ============================ 内部 ============================ */

    /**
     * 把院区参数归一成"真正的 null"。
     *
     * <p>前端下拉的"全部院区"会传空串（{@code ?hospitalCode=}），
     * 如果直接拿去 {@code eq}，就会变成"查 hospital_code = ''"，
     * 结果是全 0 而不是全院 —— 这种错看起来像"院里没数据"，
     * 排查时会先怀疑数据库，实际是参数没清洗。
     */
    private String normalizeCode(String hospitalCode) {
        if (hospitalCode == null) {
            return null;
        }
        String trimmed = hospitalCode.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private void collectDepartmentCounts(List<Map<String, Object>> rows, Map<String, Long> target) {
        for (Map<String, Object> row : rows) {
            Object dept = pick(row, "dept_name");
            if (dept == null || String.valueOf(dept).isBlank()) {
                continue;
            }
            target.merge(String.valueOf(dept), longOf(pick(row, "cnt")), Long::sum);
        }
    }

    private long count(Long v) {
        return v == null ? 0L : v;
    }

    private long longOf(Object v) {
        return v instanceof Number num ? num.longValue() : 0L;
    }

    /**
     * 按列名取值，忽略大小写。
     *
     * <p>不同驱动返回的列标签大小写不一致（H2 在 DATABASE_TO_LOWER 下给
     * {@code visit_day}，MySQL 可能给 {@code VISIT_DAY}），
     * 写死 key 会在换库时静默变成 0。
     */
    private Object pick(Map<String, Object> row, String key) {
        for (Map.Entry<String, Object> e : row.entrySet()) {
            if (e.getKey().equalsIgnoreCase(key)) {
                return e.getValue();
            }
        }
        return null;
    }

    private LocalDate toLocalDate(Object v) {
        if (v instanceof LocalDate d) {
            return d;
        }
        if (v instanceof java.sql.Date d) {
            return d.toLocalDate();
        }
        if (v instanceof LocalDateTime dt) {
            return dt.toLocalDate();
        }
        if (v instanceof java.util.Date d) {
            return d.toInstant().atZone(ZoneId.systemDefault()).toLocalDate();
        }
        if (v instanceof String s && !s.isBlank()) {
            // 只取日期部分：部分驱动会把 DATE 当 "2026-11-08 00:00:00" 返回
            return LocalDate.parse(s.length() >= 10 ? s.substring(0, 10) : s);
        }
        return null;
    }

    /* ============================ 返回结构 ============================ */

    /**
     * 概览数字。用 record 而不是 {@code Map<String,Object>}：
     * 字段名一旦是字符串，拼错时编译器不会报错，前端只会拿到 undefined。
     */
    public record Overview(
            long userCount,
            long patientCount,
            long doctorCount,
            long adminCount,
            long hospitalCount,
            long placeCount,
            long bookingCount,
            long recordCount,
            long noticeCount,
            long todayBookingCount
    ) {
    }

    /** 趋势点。date 为 ISO 日期字符串，count 为该日预约数（含 0） */
    public record TrendPoint(String date, long count) {
    }

    /** 通用"名称 + 数值"结构，科室与角色分布共用 */
    public record NameValue(String name, long value) {
    }
}
