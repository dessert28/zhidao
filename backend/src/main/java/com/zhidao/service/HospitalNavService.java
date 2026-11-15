package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.entity.HospitalPlace;
import com.zhidao.mapper.HospitalPlaceMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 院内导航 —— 把「地点」组织成「路线」。
 *
 * <p>这张表提供的是静态地点，患者真正需要的是一条**按顺序排好的路线**：
 * 先在哪报到、再去哪抽血、然后去哪见医生、最后去哪取药。
 *
 * <h3>为什么这一步值得单独写</h3>
 *
 * <p>"把 5 个地点列出来"和"告诉他先做哪个"是两件事。顺序错了会产生
 * 真实后果：让患者先见医生再抽血，医生看诊时没有当天的检验结果，
 * 那一趟就白跑了。所以顺序不是展示问题，是业务规则。
 *
 * <h3>顺序规则从哪来</h3>
 *
 * <p>{@code placeType} 本身就编码了流程位置：
 * <pre>
 *   REGISTER 挂号 → LAB 检验 → CLINIC 诊区 → EXAM 检查 → CASHIER 缴费 → PHARMACY 取药
 *                                            → REPORT 取报告
 * </pre>
 * 检验排在诊区前面，因为多数科室要求带当天结果看诊；
 * 缴费排在检查之后，因为院方先做检查再结算。
 *
 * <p>注意这是**默认顺序**，不是绝对规则 —— 有些科室要"先看医生再开检查"。
 * 所以 {@code examOnlyAfterDoctor} 这个参数允许调用方说明这种情况。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class HospitalNavService {

    private final HospitalPlaceMapper placeMapper;

    /**
     * 流程各阶段。数字是默认执行的先后。
     *
     * <p>用 Map 保持顺序（LinkedHashMap），遍历时不会因为哈希而乱序。
     */
    private static final Map<String, Integer> STAGE_ORDER = new LinkedHashMap<>();

    static {
        STAGE_ORDER.put("REGISTER", 10); // 先报到取号
        STAGE_ORDER.put("LAB", 20);      // 空腹项目必须尽早
        STAGE_ORDER.put("CLINIC", 30);   // 带结果见医生
        STAGE_ORDER.put("EXAM", 40);     // 医生开的检查
        STAGE_ORDER.put("CASHIER", 50);  // 检查后统一结算
        STAGE_ORDER.put("REPORT", 60);   // 取报告
        STAGE_ORDER.put("PHARMACY", 70); // 最后取药
        STAGE_ORDER.put("OTHER", 90);
    }

    /** 阶段的中文名，给界面直接用，避免前端再维护一份映射 */
    private static final Map<String, String> STAGE_LABEL = Map.of(
            "REGISTER", "挂号报到",
            "LAB", "检验抽血",
            "CLINIC", "看诊",
            "EXAM", "检查",
            "CASHIER", "缴费",
            "REPORT", "取报告",
            "PHARMACY", "取药",
            "OTHER", "其他"
    );

    /* ============================ 查询 ============================ */

    /** 某院区的全部地点（含科室无关的通用地点） */
    public List<HospitalPlace> listByHospital(String hospitalCode) {
        return placeMapper.selectList(new LambdaQueryWrapper<HospitalPlace>()
                .eq(HospitalPlace::getHospitalCode, hospitalCode)
                .orderByAsc(HospitalPlace::getSortOrder)
                .orderByAsc(HospitalPlace::getId));
    }

    /** 某院区 + 某科室相关的地点：通用地点 + 该科室专属地点 */
    public List<HospitalPlace> placesFor(String hospitalCode, String department) {
        return placeMapper.selectList(new LambdaQueryWrapper<HospitalPlace>()
                .eq(HospitalPlace::getHospitalCode, hospitalCode)
                // department 为空的是全院通用地点，必须带上；
                // 只查 department = '内分泌科' 会漏掉挂号处、药房
                .and(w -> w.isNull(HospitalPlace::getDepartment)
                        .or()
                        .eq(HospitalPlace::getDepartment, department))
                .orderByAsc(HospitalPlace::getSortOrder)
                .orderByAsc(HospitalPlace::getId));
    }

    /* ============================ 路线 ============================ */

    /**
     * 一步路线。
     *
     * @param order      第几步（1-based）
     * @param stage      阶段编码
     * @param stageLabel 阶段中文名
     * @param place      地点
     * @param status     状态：DONE 已过 / CURRENT 现在该去 / UPCOMING 还没到
     * @param note       这一步的注意事项（为什么要做、什么时候做）
     */
    public record RouteStep(
            int order,
            String stage,
            String stageLabel,
            HospitalPlace place,
            String status,
            String note
    ) {
    }

    /**
     * 生成就诊当日的分步路线。
     *
     * @param hospitalCode       院区
     * @param department         科室
     * @param needsFasting       是否空腹项目（决定要不要把检验排在最前）
     * @param examOnlyAfterDoctor 是否"先看医生再开检查"（部分科室是这种流程）
     * @param visitTime          预约就诊时间，作为推算各步时间的锚点
     * @param visitTime          预约就诊时间，作为推算各步时间的锚点
     * @param now                当前时间，用于判定每一步是已过 / 当前 / 未到
     * @return 排好序的路线；该院区没配数据时返回空列表
     */
    public List<RouteStep> buildRoute(
            String hospitalCode,
            String department,
            boolean needsFasting,
            boolean examOnlyAfterDoctor,
            LocalDateTime visitTime,
            LocalDateTime now) {

        List<HospitalPlace> places = placesFor(hospitalCode, department);
        if (places.isEmpty()) {
            return List.of();
        }

        /*
         * 排序：先按阶段，再按 sort_order。
         *
         * 特殊情况：examOnlyAfterDoctor 为真时，
         * 该科室的检查要挪到看诊之后。默认顺序本来就是 EXAM 在 CLINIC 之后，
         * 所以这条分支实际只在"有检验、但医生要先看"的时候才生效 ——
         * 那种情况下检验也不能排太前，改为跟着看诊走。
         */
        List<HospitalPlace> sorted = new ArrayList<>(places);
        sorted.sort((a, b) -> {
            int sa = stageOrderOf(a.getPlaceType(), needsFasting, examOnlyAfterDoctor);
            int sb = stageOrderOf(b.getPlaceType(), needsFasting, examOnlyAfterDoctor);
            if (sa != sb) return Integer.compare(sa, sb);
            int oa = a.getSortOrder() == null ? 100 : a.getSortOrder();
            int ob = b.getSortOrder() == null ? 100 : b.getSortOrder();
            if (oa != ob) return Integer.compare(oa, ob);
            return Long.compare(a.getId() == null ? 0 : a.getId(), b.getId() == null ? 0 : b.getId());
        });

        /* ---- 判定每一步的状态 ---- */
        /*
         * 状态要按时间算，不能"第一个就是 CURRENT"。
         *
         * 第一版就是这么写的，实测发现：无论什么时候看，第 1 步永远是
         * CURRENT、后面永远是 UPCOMING —— 已经办完的步骤和还没到的步骤
         * 看起来一模一样，患者分不清"我做完到哪了"。
         *
         * 正确做法：以诊区那一步为锚点（必须准时到），用各步的
         * estMinutes 倒推/顺推，得到每步的建议时间点：
         *   建议时间已过 + 距离下一个还早  → DONE（应该已经办完了）
         *   第一个建议时间还没过的          → CURRENT
         *   其余                            → UPCOMING
         */
        List<RouteStep> steps = new ArrayList<>();
        int order = 1;

        int clinicIdx = -1;
        for (int i = 0; i < sorted.size(); i++) {
            if ("CLINIC".equals(sorted.get(i).getPlaceType())) {
                clinicIdx = i;
                break;
            }
        }

        // 没有诊区（理论上不该发生）时，退化为"全部 UPCOMING 但第一个标 CURRENT"
        if (clinicIdx < 0) {
            for (HospitalPlace p : sorted) {
                steps.add(new RouteStep(order, p.getPlaceType(),
                        STAGE_LABEL.getOrDefault(p.getPlaceType(), "其他"),
                        p, order == 1 ? "CURRENT" : "UPCOMING", noteFor(p, needsFasting)));
                order++;
            }
            return steps;
        }

        LocalDateTime[] suggested = suggestTimes(sorted, clinicIdx, visitTime);

        /*
         * 找到"当前该做的那一步"：第一个建议时间还没过的。
         * 全部过完了就停在最后一步（迟到了，该直奔最后）。
         */
        int currentIdx = sorted.size() - 1;
        for (int i = 0; i < sorted.size(); i++) {
            if (suggested[i] != null && suggested[i].isAfter(now)) {
                currentIdx = i;
                break;
            }
        }

        for (int i = 0; i < sorted.size(); i++) {
            HospitalPlace p = sorted.get(i);
            String status;
            if (i < currentIdx) {
                status = "DONE";
            } else if (i == currentIdx) {
                status = "CURRENT";
            } else {
                status = "UPCOMING";
            }
            steps.add(new RouteStep(order, p.getPlaceType(),
                    STAGE_LABEL.getOrDefault(p.getPlaceType(), "其他"),
                    p, status, noteFor(p, needsFasting)));
            order++;
        }

        return steps;
    }

    /**
     * 各步的建议时间点。
     *
     * <p>以诊区为锚点（预约时间必须准时），按 estMinutes 往前/往后推。
     * 抽出来单独一个方法是因为 {@code currentStep} 也要用它 ——
     * 同一套推算写两遍，早晚会不一致。
     */
    private LocalDateTime[] suggestTimes(
            List<HospitalPlace> sorted, int clinicIdx, LocalDateTime visitTime) {

        LocalDateTime[] suggested = new LocalDateTime[sorted.size()];
        suggested[clinicIdx] = visitTime;

        LocalDateTime cursor = visitTime;
        for (int i = clinicIdx - 1; i >= 0; i--) {
            int mins = sorted.get(i).getEstMinutes() == null ? 10 : sorted.get(i).getEstMinutes();
            cursor = cursor.minusMinutes(mins);
            suggested[i] = cursor;
        }
        cursor = visitTime;
        for (int i = clinicIdx + 1; i < sorted.size(); i++) {
            int mins = sorted.get(i).getEstMinutes() == null ? 10 : sorted.get(i).getEstMinutes();
            cursor = cursor.plusMinutes(mins);
            suggested[i] = cursor;
        }
        return suggested;
    }

    /**
     * 某地点在本次流程中的阶段序号。
     *
     * <p>把"是否空腹""是否先看医生"这两个业务条件编码进排序，
     * 而不是在调用方再排一遍 —— 排序规则分散到两处，早晚会不一致。
     */
    private int stageOrderOf(String placeType, boolean needsFasting, boolean examOnlyAfterDoctor) {
        Integer base = STAGE_ORDER.get(placeType);
        if (base == null) return 90;

        // 不需要空腹时，检验不必抢在诊区前面（避免让患者白等）
        if ("LAB".equals(placeType) && !needsFasting) {
            return STAGE_ORDER.get("CLINIC") - 1; // 仍然略早于看诊，但不占最前
        }
        // 某些科室要求医生先看再开检查
        if ("EXAM".equals(placeType) && examOnlyAfterDoctor) {
            return STAGE_ORDER.get("CLINIC") + 1;
        }
        return base;
    }

    /** 这一步的注意事项 —— 只说对患者有用的话 */
    private String noteFor(HospitalPlace p, boolean needsFasting) {
        String type = p.getPlaceType();
        if ("LAB".equals(type) && needsFasting) {
            return "需要空腹。前一晚 22 点后禁食，可少量饮水；抽血尽量在早上完成。";
        }
        if ("CLINIC".equals(type)) {
            return "带上既往检查报告与用药清单；到达后在诊区门口二次报到。";
        }
        if ("CASHIER".equals(type)) {
            return "检查、取药前先完成缴费，自助机与人工窗口都可。";
        }
        if ("PHARMACY".equals(type)) {
            return "先缴费再取药，按取药条上的窗口号排队。";
        }
        return "";
    }

    /* ============================ 当前该去哪 ============================ */

    /**
     * 现在该去第几步。
     *
     * <p>为什么需要这个而不是让前端自己算：判断"该去哪"要结合
     * 预约时间、地点办理时长、当前时刻三者，逻辑放在服务端只有一份。
     *
     * <p>算法：从预约时间倒推 —— 该在预约前完成的步骤（报到、抽血）
     * 按 estMinutes 累加，得到每一步的建议时间点；
     * 取第一个"建议时间点还没过"的步骤作为当前步骤。
     *
     * @return 当前步骤；路线为空时返回 empty
     */
    public Optional<RouteStep> currentStep(
            String hospitalCode,
            String department,
            boolean needsFasting,
            LocalDateTime visitTime,
            LocalDateTime now) {

        List<RouteStep> route = buildRoute(hospitalCode, department, needsFasting, false, visitTime, now);
        if (route.isEmpty()) return Optional.empty();

        /*
         * buildRoute 已经在每一步上标好了 DONE / CURRENT / UPCOMING，
         * 这里只要挑出 CURRENT 那一步。
         *
         * 第一版在这里又推算了一遍时间，与 buildRoute 里的逻辑重复 ——
         * 两处推算早晚会不一致（改一处忘另一处）。现在收敛成一处。
         */
        for (RouteStep s : route) {
            if ("CURRENT".equals(s.status())) {
                return Optional.of(s);
            }
        }
        // 理论上不该到这里（buildRoute 必定标出一个 CURRENT），兜底给最后一步
        return Optional.of(route.get(route.size() - 1));
    }

    /** 给校验用：某地点类型是否已知 */
    public static boolean isKnownStage(String placeType) {
        return STAGE_ORDER.containsKey(placeType);
    }

    /** 给健康检查用：某院区配了多少地点 */
    public long countPlaces(String hospitalCode) {
        return placeMapper.selectCount(new LambdaQueryWrapper<HospitalPlace>()
                .eq(HospitalPlace::getHospitalCode, hospitalCode));
    }

    /** 晚于某时刻是否还在营业时间（粗判，只用于提示"可能已关门"） */
    public static boolean maybeClosed(HospitalPlace p, LocalDateTime now) {
        String hours = p.getOpenHours();
        if (hours == null || hours.isBlank()) return false;
        // 只处理「周一至周六 7:30-16:00」这一种格式，解析失败就当营业
        try {
            int dash = hours.lastIndexOf(' ');
            if (dash < 0) return false;
            String range = hours.substring(dash + 1);
            String[] parts = range.split("-");
            if (parts.length != 2) return false;
            LocalTime end = parseHm(parts[1]);
            return end != null && now.toLocalTime().isAfter(end);
        } catch (RuntimeException e) {
            return false;
        }
    }

    private static LocalTime parseHm(String s) {
        try {
            String[] hm = s.trim().split(":");
            return LocalTime.of(Integer.parseInt(hm[0]), Integer.parseInt(hm[1]));
        } catch (RuntimeException e) {
            return null;
        }
    }
}
