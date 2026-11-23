package com.zhidao.agent;

import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Scheduler 意图抽取与就诊时间轴 —— 对照 frontend/server/agents/scheduler.ts 的纯逻辑部分。
 *
 * <p>科室别名、院区识别、日期解析、时间轴生成全是确定性规则，逐字对齐 TS 版。
 * 号源查询本身在迁移后由编排层直接调后端 Service（不再需要 BFF 的 HTTP 工具层），
 * 这部分不属于本类职责。
 */
@Component
public class SchedulerIntentParser {

    /** 挂号意图 */
    public record BookingIntent(String department, String hospitalCode, String date) {}

    /** 科室别名表 —— 对照 DEPARTMENT_ALIASES */
    private static final List<Alias> DEPARTMENT_ALIASES = List.of(
            new Alias(Pattern.compile("心内科|心脏病|冠心病"), "心血管内科"),
            new Alias(Pattern.compile("内分泌|血糖|糖尿|甲状腺"), "内分泌科"),
            new Alias(Pattern.compile("消化|胃肠|肚子|胃疼|胃痛"), "消化内科"),
            new Alias(Pattern.compile("呼吸|咳嗽|气喘|肺部"), "呼吸内科"),
            new Alias(Pattern.compile("神经内科|头晕|头痛|偏头痛|失眠"), "神经内科"),
            new Alias(Pattern.compile("骨科|关节|腰|颈椎|膝盖"), "骨科"),
            new Alias(Pattern.compile("皮肤|皮疹|瘙痒|过敏"), "皮肤科"),
            new Alias(Pattern.compile("妇科|月经|痛经|白带"), "妇科"),
            new Alias(Pattern.compile("眼睛|视力|眼科"), "眼科"),
            new Alias(Pattern.compile("牙|口腔|牙龈"), "口腔科"),
            new Alias(Pattern.compile("耳朵|咽喉|嗓子|鼻子|耳鸣"), "耳鼻咽喉科")
    );
    private record Alias(Pattern pattern, String name) {}

    private static final List<String> KNOWN_DEPARTMENTS = List.of(
            "心血管内科", "内分泌科", "消化内科", "呼吸内科", "神经内科", "骨科",
            "皮肤科", "妇科", "眼科", "口腔科", "耳鼻咽喉科", "全科医学科");

    private static final Pattern HOSPITAL_Z2 = Pattern.compile("浙(大|江大学.*第)?二院|浙二|第二医院|解放路", Pattern.CASE_INSENSITIVE);
    private static final Pattern MD = Pattern.compile("(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*[日号]");

    /** 解析挂号意图 —— 对照 parseBookingIntent；抽不到科室返回 null */
    public BookingIntent parseBookingIntent(String text) {
        if (text == null || text.trim().isEmpty()) return null;
        String t = text.trim();

        String department = null;
        for (String d : KNOWN_DEPARTMENTS) {
            if (t.contains(d)) { department = d; break; }
        }
        if (department == null) {
            for (Alias a : DEPARTMENT_ALIASES) {
                if (a.pattern().matcher(t).find()) { department = a.name(); break; }
            }
        }
        if (department == null) return null;

        String hospitalCode = HOSPITAL_Z2.matcher(t).find() ? "Z2-JFL" : null;
        String date = parseDate(t, LocalDate.now());
        return new BookingIntent(department, hospitalCode, date);
    }

    /** 日期解析 —— 对照 parseDate，返回 YYYY-MM-DD */
    public String parseDate(String text, LocalDate now) {
        if (text == null) return null;
        if (text.matches(".*(今天|今日).*")) return now.toString();
        if (text.matches(".*(明天|明日).*")) return now.plusDays(1).toString();
        if (text.contains("后天")) return now.plusDays(2).toString();

        int[] weekdayTargets = {1, 2, 3, 4, 5, 6, 0};
        Pattern[] weekdayPatterns = {
                Pattern.compile("下?周[一1]"), Pattern.compile("下?周[二2]"),
                Pattern.compile("下?周[三3]"), Pattern.compile("下?周[四4]"),
                Pattern.compile("下?周[五5]"), Pattern.compile("下?周[六6]"),
                Pattern.compile("下?周[日天]")
        };
        for (int i = 0; i < weekdayPatterns.length; i++) {
            Matcher m = weekdayPatterns[i].matcher(text);
            if (m.find()) {
                int target = weekdayTargets[i];
                int cur = now.getDayOfWeek().getValue() % 7; // 周一=1..周日=0
                int delta = (target - cur + 7) % 7;
                if (text.contains("下周") && delta < 7) delta += 7;
                if (delta == 0) delta = 7;
                return now.plusDays(delta).toString();
            }
        }

        Matcher m = MD.matcher(text);
        if (m.find()) {
            int month = Integer.parseInt(m.group(1));
            int day = Integer.parseInt(m.group(2));
            if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                int year = month < now.getMonthValue() ? now.getYear() + 1 : now.getYear();
                return String.format("%04d-%02d-%02d", year, month, day);
            }
        }
        return null;
    }

    /** 就诊时间轴任务 */
    public record TimelineTask(int order, String task, List<String> dependsOn, String note) {}

    /** 生成就诊当日时间轴 —— 对照 buildTimeline */
    public List<TimelineTask> buildTimeline(String department, String visitTime) {
        boolean needsFasting = Pattern.compile("内分泌|消化").matcher(department == null ? "" : department).find();
        List<TimelineTask> tasks = new ArrayList<>();
        int order = 1;
        if (needsFasting) {
            tasks.add(new TimelineTask(order++, "空腹抽血（先做，避免进食影响结果）",
                    List.of(), "前一晚 22 点后禁食，可少量饮水"));
        }
        String timeNote = (visitTime != null && visitTime.length() >= 16)
                ? "预约时间 " + visitTime.substring(11, 16) + "，建议提前 20 分钟到" : "";
        tasks.add(new TimelineTask(order++, "到科室分诊台报到", List.of(), timeNote));
        String seeDoctor = "见" + department + "医生";
        tasks.add(new TimelineTask(order++, seeDoctor,
                needsFasting ? List.of("空腹抽血") : List.of(), "带上既往检查报告与用药清单"));
        tasks.add(new TimelineTask(order++, "按医嘱补做检查", List.of(seeDoctor),
                "如有检查，先看是否需要预约、是否当天可出结果"));
        return tasks;
    }
}
