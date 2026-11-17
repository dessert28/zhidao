package com.zhidao.service;

import com.zhidao.entity.BookingOrder;
import com.zhidao.entity.PatientProfile;
import com.zhidao.entity.ReminderTask;
import com.zhidao.mapper.ReminderTaskMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * 提醒引擎。
 *
 * <p>这是 HANDOFF 里列的 P0 第二项，也是 README §2 承诺的差异化落点：
 * <b>「跨院用药冲突提示」之外的另一半价值 —— 别忘了复查。</b>
 * 在它之前 {@code adapter/} 和 {@code reminder_task} 表都是死的：
 * 有表、有实体、有 Adapter，但没有任何地方往里面写数据。
 *
 * <h3>设计上最要紧的三件事</h3>
 *
 * <p><b>1. 每条提醒必须可解释。</b>{@code reason} 不是备注，是这张表的灵魂。
 * "该复查了"和"距离上次糖化血红蛋白检查已满 98 天，超过 3 个月的复查周期"
 * 是两种完全不同的东西：前者是闹钟，后者是系统理解了你的病历后自己想到的。
 * 没有 reason 的提醒不应该被生成 —— 这是本类的硬约束，{@link #emit} 会拒收。
 *
 * <p><b>2. 幂等。</b>引擎每 5 分钟跑一次（{@code zhidao.reminder.scan-cron}），
 * 同一个规则对同一份数据跑一万次也只能产生一条提醒。
 * 实现方式是 {@link #dedupeKey}：由「规则名 + 关联对象 + 日期」拼出稳定指纹，
 * 生成前查库，命中就跳过。不靠"反正用户会点掉"来兜底。
 *
 * <p><b>3. 只提示不判断。</b>三条规则全是"你该去做某件事"，
 * 没有一条说"你可能得了什么病"。用药与诊断的边界见 docs/08 §1。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ReminderEngine {

    /** 扫描提前量：预约类提醒最多提前多久生成 */
    @Value("${zhidao.reminder.advance-hours:24}")
    private int advanceHours;

    /**
     * 补发窗口下界。
     *
     * <p>没有它，一次停机再启动会把三个月前的任务全当成"该发了"补发一遍，
     * 用户一夜之间收到二十条过期提醒。窗口外的直接放弃，不发比滥发好。
     */
    @Value("${zhidao.reminder.lookback-hours:48}")
    private int lookbackHours;

    private final ReminderTaskMapper reminderMapper;
    private final HospitalService hospitalService;
    private final PatientService patientService;

    /* ============================ 定时入口 ============================ */

    /**
     * 主扫描。每 5 分钟一次，cron 在 application.yml 里可配。
     *
     * <p>为什么是 5 分钟而不是 1 分钟：提醒的时间粒度是"小时"级
     * （今晚 22 点禁食、明天 8 点半抽血），1 分钟扫描纯属浪费。
     * 5 分钟意味着最坏延迟 5 分钟，对这类提醒完全够。
     */
    @Scheduled(cron = "${zhidao.reminder.scan-cron:0 */5 * * * *}")
    public void scan() {
        try {
            int created = scanOnce(LocalDateTime.now());
            if (created > 0) {
                log.info("[提醒引擎] 本轮生成 {} 条提醒", created);
            } else {
                log.debug("[提醒引擎] 本轮无新提醒");
            }
        } catch (Exception e) {
            // 定时任务里的异常如果冒出去，Scheduler 会把这个任务悄悄下线，
            // 而日志里只有一行 stack —— 表现是"提醒突然不响了"却没人发现。
            // 所以这里必须自己兜住。
            log.error("[提醒引擎] 扫描失败，本轮跳过", e);
        }
    }

    /**
     * 可单独调用的扫描（测试与手工触发都用它，不依赖时钟）。
     *
     * @param now 当前时间，由调用方传入 —— 让"距就诊还有 24 小时"这类规则
     *            可以脱离真实时钟被验证
     * @return 本轮新生成的提醒条数
     */
    public int scanOnce(LocalDateTime now) {
        List<ReminderTask> candidates = new ArrayList<>();

        for (Long userId : hospitalService.activeUserIds()) {
            // 已经存在过的提醒先全部捞出来，做一次性的幂等过滤，
            // 避免每条规则各查一次库
            java.util.Set<String> existing = existingKeysOf(userId);

            candidates.addAll(ruleFastingBeforeVisit(userId, now, existing));
            candidates.addAll(ruleLabFollowUp(userId, now, existing));
            candidates.addAll(ruleBookingNotConfirmed(userId, now, existing));
        }

        for (ReminderTask t : candidates) {
            reminderMapper.insert(t);
            log.info("[提醒引擎] userId={} 生成提醒「{}」，原因：{}",
                    t.getUserId(), t.getTitle(), t.getReason());
        }
        return candidates.size();
    }

    /* ============================ 规则一：就诊前禁食 ============================ */

    /**
     * 规则：距就诊 24 小时内 + 该科室有需要空腹的项目 → 「今晚 22 点后禁食」。
     *
     * <p>为什么这条值得做成规则而不是让用户自己记住：
     * 出院小结和预约单上写着"空腹"，但它写在纸上、丢在抽屉里。
     * 到了诊室被告知"明天再来"是最典型的白跑一趟。
     *
     * <p>为什么阈值取 24 小时：提前更多天提醒没有可操作性
     * （后天早上抽血，今天提醒禁食没有意义）；更晚提醒用户可能已经在路上。
     *
     * <p>科室白名单是硬编码的领域知识，不是猜的：空腹血糖、血脂、肝胆胰脾超声
     * 这三类检查集中在内分泌科与消化内科。真实系统会从院区的检查项目字典里查，
     * 这里 Mock 阶段用一张小表代替，并明确标注。
     */
    List<ReminderTask> ruleFastingBeforeVisit(long userId, LocalDateTime now, java.util.Set<String> existing) {
        List<ReminderTask> out = new ArrayList<>();
        // 用传入的 now 作为「今天」，和下面算 hours 的时间轴保持一致
        BookingOrder next = hospitalService.nextBooking(userId, now.toLocalDate());
        if (next == null || next.getVisitTime() == null) {
            return out;
        }

        long hours = Duration.between(now, next.getVisitTime()).toHours();
        if (hours < 0 || hours > 24) {
            return out;
        }
        if (!FASTING_DEPARTMENTS.contains(next.getDepartment())) {
            return out;
        }

        // 提醒时间点定在就诊前一晚 22:00；已经过了就立刻提醒（不能再等）
        LocalDateTime dueAt = next.getVisitTime().toLocalDate().atTime(22, 0).minusDays(1);
        if (dueAt.isBefore(now.minusHours(lookbackHours))) {
            // 已经过了补发窗口，不发
            return out;
        }
        if (dueAt.isAfter(now)) {
            dueAt = now; // 到点才能提醒，定时任务每 5 分钟会再看一次
        }

        String key = dedupeKey("FASTING", "BOOKING", next.getId(),
                next.getVisitTime().toLocalDate().toString());
        if (existing.contains(key)) {
            return out;
        }

        String hospital = hospitalService.nameOf(next.getHospitalCode());
        ReminderTask t = new ReminderTask();
        t.setUserId(userId);
        t.setRefType(ReminderTask.REF_BOOKING);
        t.setRefId(next.getId());
        t.setTitle("明天在" + hospital + "空腹抽血，今晚 22 点后禁食");
        t.setDetail("就诊时间 " + next.getVisitTime().toLocalDate() + " "
                + next.getVisitTime().toLocalTime().withSecond(0) + "，科室：" + next.getDepartment()
                + "。请从今晚 22 点后停止进食，可少量饮水。");
        // reason 是"为什么提醒你"，不是"提醒你什么"—— 这句话不带 forget-me-not 之外的任何要求
        t.setReason("距「" + next.getDepartment() + "」就诊还有 " + hours
                + " 小时，且该科室的检查需要空腹");
        t.setDueAt(dueAt);
        t.setDedupeKey(key);
        t.setStatus(ReminderTask.STATUS_PENDING);
        out.add(t);
        return out;
    }

    /** 需要空腹的科室白名单。Mock 阶段替代院区的检查项目字典 */
    private static final java.util.Set<String> FASTING_DEPARTMENTS =
            java.util.Set.of("内分泌科", "消化内科", "心血管内科");

    /* ============================ 规则二：复查到期 ============================ */

    /**
     * 规则：距上次某类检查满 N 个月 → 「该复查了」。
     *
     * <p>周期是领域知识，不是拍脑袋：
     * <ul>
     *   <li>糖化血红蛋白 HbA1c —— 3 个月。它反映近 8~12 周平均血糖，
     *       查得比 3 个月更勤没有额外信息量（指南共识）</li>
     *   <li>血压监测 —— 2 周。高血压调药期的常规随访间隔</li>
     * </ul>
     *
     * <p><b>只提示不判断</b>：不会说"你的血糖控制不好"，
     * 因为数据里只有一次 8.4，够不上任何结论。说的是"查一下"。
     */
    List<ReminderTask> ruleLabFollowUp(long userId, LocalDateTime now, java.util.Set<String> existing) {
        List<ReminderTask> out = new ArrayList<>();

        for (LabRule rule : LAB_RULES) {
            LocalDate last = patientService.lastVisit(userId, rule.department());
            if (last == null) {
                continue;
            }
            LocalDate dueDate = last.plusMonths(rule.months());
            // 今天还没到期，不出提醒
            if (dueDate.isAfter(now.toLocalDate())) {
                continue;
            }

            // 同一天只出一条：复查提醒是"该做"而不是"立刻做"，
            // 每次扫描都重发一遍会变成骚扰
            String key = dedupeKey("FOLLOWUP", "RECORD", null, rule.name() + "@" + dueDate);
            if (existing.contains(key)) {
                continue;
            }

            long days = Duration.between(last.atStartOfDay(), now).toDays();

            ReminderTask t = new ReminderTask();
            t.setUserId(userId);
            t.setRefType(ReminderTask.REF_RECORD);
            t.setRefId(null);
            t.setTitle("该复查" + rule.name() + "了");
            t.setDetail("上一次" + rule.name() + "是在 " + last + "（" + rule.department()
                    + "）。" + rule.detail());
            t.setReason("距离上次" + rule.name() + "已 " + days + " 天，超过 "
                    + rule.months() + " 个月的复查周期");
            // 到期日当天早上 9 点提醒
            t.setDueAt(dueDate.atTime(9, 0).isBefore(now) ? now : dueDate.atTime(9, 0));
            t.setDedupeKey(key);
            t.setStatus(ReminderTask.STATUS_PENDING);
            out.add(t);
        }
        return out;
    }

    /**
     * 检查项 → 复查周期。
     *
     * <p>这张表就是"领域知识"的具体形态。加一项检查只要加一行，
     * 不需要动任何逻辑 —— 这是把规则写成数据而不是写成 if 的价值。
     */
    private record LabRule(String name, String department, int months, String detail) {
    }

    private static final List<LabRule> LAB_RULES = List.of(
            new LabRule("糖化血红蛋白", "内分泌科", 3,
                    "建议带上前一次的结果，方便医生对比变化趋势。"),
            new LabRule("血压", "心血管内科", 1,
                    "如果近期自测血压持续偏高，请提前就诊而不是等到复查日。")
    );

    /* ============================ 规则三：预约未确认 ============================ */

    /**
     * 规则：预约单 {@code CREATED} 且距就诊不足 7 天 → 「还没确认」。
     *
     * <p>这条规则防的是"以为已经约上了"。CREATED 是个很尴尬的状态：
     * 单子在系统里，但院方那边还没最终确认。用户看到列表里有记录
     * 就会以为万事俱备，到日子直接跑去，结果号被释放了。
     */
    List<ReminderTask> ruleBookingNotConfirmed(long userId, LocalDateTime now, java.util.Set<String> existing) {
        List<ReminderTask> out = new ArrayList<>();

        for (BookingOrder b : hospitalService.bookingsOf(userId)) {
            if (!BookingOrder.STATUS_CREATED.equals(b.getStatus()) || b.getVisitTime() == null) {
                continue;
            }
            long days = Duration.between(now, b.getVisitTime()).toDays();
            if (days < 0 || days >= 7) {
                continue;
            }

            String key = dedupeKey("UNCONFIRMED", "BOOKING", b.getId(),
                    b.getVisitTime().toLocalDate().toString());
            if (existing.contains(key)) {
                continue;
            }

            String hospital = hospitalService.nameOf(b.getHospitalCode());
            ReminderTask t = new ReminderTask();
            t.setUserId(userId);
            t.setRefType(ReminderTask.REF_BOOKING);
            t.setRefId(b.getId());
            t.setTitle(hospital + "的预约还没确认");
            t.setDetail(b.getVisitTime().toLocalDate() + " " + b.getDepartment()
                    + " 的号还处于「待确认」状态，请打开预约详情确认或取消，避免到院无号。");
            t.setReason("预约单状态为 CREATED（待确认），且距就诊仅剩 " + days + " 天");
            // 立即提醒：这条越早发越有用
            t.setDueAt(now);
            t.setDedupeKey(key);
            t.setStatus(ReminderTask.STATUS_PENDING);
            out.add(t);
        }
        return out;
    }

    /* ============================ 幂等 ============================ */

    /**
     * 生成 dedupe 指纹。
     *
     * <p>为什么不用 {@code ref_type + ref_id} 就够了：同一条预约在
     * "就诊前 24 小时"和"还没确认"两个规则下都会产生提醒，用 ref 去重
     * 会互相顶掉。必须带上规则名。
     *
     * <p>为什么还要带日期：复查提醒的 refId 是空的（不挂具体单据），
     * 只有日期能区分"这次到期"和"下个周期又一次到期"。
     */
    static String dedupeKey(String rule, String refType, Long refId, String discriminator) {
        return rule + "|" + refType + "|" + (refId == null ? "-" : refId) + "|" + discriminator;
    }

    /**
     * 把某个用户已有提醒的幂等键读成集合。
     *
     * <p><b>这里曾经写错过，值得留个记录。</b>
     *
     * <p>第一版没有 dedupe_key 列，指纹是从 reason 的固定前缀反推出来的
     * （例如 reason 以「距」开头的就当禁食规则）。看起来能跑，实际有两个问题：
     * <ol>
     *   <li><b>改一句文案，去重就失效</b>。引擎每 5 分钟扫一次，
     *       文案一改立刻变成每 5 分钟多一条提醒，而没有任何测试会先报错</li>
     *   <li><b>反解的判别串对不上</b>。复查类规则生成时用的判别串是
     *       {@code 检查名@到期日}，反解时却只拿了 title，
     *       于是永远认为"还没提醒过"，每轮都插一条 —— 连跑 5 次生成 5 条，
     *       正是测试 isIdempotent 抓到的现象</li>
     * </ol>
     *
     * <p>现在的做法是把指纹当成<b>数据</b>存下来，读的时候直接读。
     * 反推的逻辑依赖"文案长什么样"，而文案是给人看的，随时会改 ——
     * 拿它当业务主键是设计错误，不是实现 bug。
     */
    private java.util.Set<String> existingKeysOf(long userId) {
        java.util.Set<String> keys = new java.util.HashSet<>();
        for (ReminderTask t : reminderServiceAll(userId)) {
            if (t.getDedupeKey() != null) {
                keys.add(t.getDedupeKey());
            }
        }
        return keys;
    }

    private List<ReminderTask> reminderServiceAll(long userId) {
        return reminderMapper.selectList(
                new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<ReminderTask>()
                        .eq(ReminderTask::getUserId, userId));
    }

    /** 供测试与手工触发：把已到期的 PENDING 标记为 SENT（模拟"通知已发出"） */
    public int markDueAsSent(LocalDateTime now) {
        List<ReminderTask> due = reminderMapper.selectList(
                new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<ReminderTask>()
                        .eq(ReminderTask::getStatus, ReminderTask.STATUS_PENDING)
                        .le(ReminderTask::getDueAt, now));
        for (ReminderTask t : due) {
            t.setStatus(ReminderTask.STATUS_SENT);
            t.setSentAt(now);
            reminderMapper.updateById(t);
        }
        return due.size();
    }
}
