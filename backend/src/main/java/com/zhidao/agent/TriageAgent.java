package com.zhidao.agent;

import com.zhidao.agent.contract.AgentEvent;
import com.zhidao.agent.contract.AgentOutput;
import com.zhidao.agent.contract.RedFlag;
import com.zhidao.agent.contract.TriagePayload;
import com.zhidao.agent.rules.RedFlagRule;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.function.BiFunction;
import java.util.regex.Pattern;

/**
 * Triage Agent —— 对照 frontend/server/agents/triage.ts 的规则逻辑。
 *
 * <p>四条硬约束：① 红线短路二次确认 ② 最多追问 3 轮 ③ 低置信给 Top3+兜底
 * ④ LLM 失败走关键词规则表，绝不返回空科室。
 *
 * <p>槽位提取、科室规则、置信度、追问话术全部是确定性规则，逐字对齐 TS 版。
 * 可选 LLM 分析通过 analyzeFn 注入（无 Key 时为 null → 纯规则路径）。
 */
@Slf4j
@Component
public class TriageAgent {

    private static final int MAX_CLARIFY_ROUNDS = 3;
    private static final double MIN_CONFIDENCE = 0.5;

    private static final List<String> SLOT_KEYS = List.of("部位", "时长", "性质", "诱因", "伴随");
    private static final List<String> REQUIRED_SLOTS = List.of("部位", "时长");
    private static final List<String> FALLBACK_DEPARTMENTS = List.of("全科医学科", "门诊导诊台");

    /** 槽位提取正则表 —— 对照 SLOT_PATTERNS */
    private static final Map<String, List<Pattern>> SLOT_PATTERNS = new LinkedHashMap<>();
    static {
        SLOT_PATTERNS.put("部位", List.of(
                Pattern.compile("(头|额头|太阳穴|后脑|头顶|颈|脖子)"),
                Pattern.compile("(胸|心口|乳房)"),
                Pattern.compile("(腹|肚子|胃|上腹|下腹|肚脐)"),
                Pattern.compile("(腰|背|肩|颈椎)"),
                Pattern.compile("(手|脚|手指|脚趾|关节|膝盖|腿|胳膊|臂)"),
                Pattern.compile("(牙|口腔|咽喉|嗓子|耳朵|鼻子|眼睛|眼)"),
                Pattern.compile("(皮肤|全身)")));
        SLOT_PATTERNS.put("时长", List.of(
                Pattern.compile("(\\d+|[一二两三四五六七八九十半几]+)\\s*(分钟|小时|天|周|个?月|年)"),
                Pattern.compile("(昨天|前天|今天|早上|晚上|刚才|持续|最近|一直|几天)")));
        SLOT_PATTERNS.put("性质", List.of(
                Pattern.compile("(疼|痛|酸|胀|麻|痒|烧灼|刺痛|钝痛|绞痛|隐痛|剧痛|闷|堵)"),
                Pattern.compile("(咳嗽|发热|发烧|呕吐|腹泻|便秘|头晕|乏力|失眠|心慌|气短)")));
        SLOT_PATTERNS.put("诱因", List.of(
                Pattern.compile("(吃|喝|活动|运动|劳累|受凉|熬夜|情绪|按压|空腹|饭后)")));
        SLOT_PATTERNS.put("伴随", List.of(
                Pattern.compile("(伴|还有|同时|另外|加上).{0,12}(发热|呕吐|腹泻|头痛|乏力|出汗|恶心)")));
    }

    private static final Pattern SELF_LOCATED = Pattern.compile(
            "咳嗽|咳痰|黄痰|白痰|气喘|哮喘|气短|呼吸困难|流涕|鼻塞|咽痛|喉咙痛|耳鸣|视力|尿频|尿急|尿痛|月经|痛经|白带|皮疹|瘙痒|腹泻|拉肚子|便秘|反酸|烧心|心慌|心悸|胸闷");
    private static final Pattern LAB_INDICATOR = Pattern.compile(
            "血糖|血脂|胆固醇|甘油三酯|低密度脂蛋白|转氨酶|肌酐|尿酸|糖化血红蛋白|甲功|甲状腺功能|白细胞|血红蛋白|血常规|尿常规|指标|化验|体检报告|检查结果|报告单");
    private static final Pattern BODY_COMPLAINT = Pattern.compile(
            "疼|痛|闷|不舒服|难受|乏力|头晕|恶心|呕吐|发热|发烧|咳|喘|麻|肿|痒");
    private static final Pattern VAGUE_TIME = Pattern.compile(
            "^(最近|一直|这几天|前几天|平时|偶尔|有时|时不时|老是|总是)$");

    /** 追问话术 —— 逐字对齐 QUESTIONS */
    private static final Map<String, String> QUESTIONS = new LinkedHashMap<>();
    static {
        QUESTIONS.put("部位", "具体是哪个位置不舒服？比如额头、胸口、肚子左边？");
        QUESTIONS.put("时长", "这个情况大概多久了？几个小时，还是好几天了？");
        QUESTIONS.put("性质", "是怎么个难受法？针扎一样疼、闷闷地胀，还是酸麻？");
        QUESTIONS.put("诱因", "有没有什么情况下会加重或缓解？比如吃完饭、活动后？");
        QUESTIONS.put("伴随", "除了这个，还有别的不舒服吗？比如发热、恶心、乏力？");
    }

    /** 科室规则表 —— 对照 DEPT_RULES */
    private record DeptRule(Pattern keywords, List<String> departments, String reason) {}
    private static final List<DeptRule> DEPT_RULES = List.of(
            new DeptRule(Pattern.compile("胸.{0,2}(痛|闷|疼|紧|压)|心慌|心悸|心跳快|血压高"), List.of("心血管内科"), "症状指向心血管系统"),
            new DeptRule(Pattern.compile("咳|嗽|痰|喘|呼吸困难|气短|气促|肺"), List.of("呼吸内科"), "症状指向呼吸系统"),
            new DeptRule(Pattern.compile("胃|腹|肚子|肚脐|恶心|呕吐|腹泻|拉肚子|便秘|消化|反酸"), List.of("消化内科"), "症状指向消化系统"),
            new DeptRule(Pattern.compile("头.{0,2}(晕|痛|疼|胀|沉)|失眠|手麻|抽搐|记忆|偏头痛"), List.of("神经内科"), "症状指向神经系统"),
            new DeptRule(Pattern.compile("血糖|糖尿|口渴|多尿|甲状腺|体重下降|甲亢|甲减"), List.of("内分泌科"), "症状指向内分泌代谢"),
            new DeptRule(Pattern.compile("关节|腰|颈|肩|膝|骨|扭伤|颈椎|腰椎"), List.of("骨科"), "症状指向骨关节"),
            new DeptRule(Pattern.compile("皮肤|疹|痒|斑|过敏|起疙瘩"), List.of("皮肤科"), "症状指向皮肤"),
            new DeptRule(Pattern.compile("尿|肾|排尿|水肿|尿频|尿急"), List.of("肾内科"), "症状指向泌尿系统"),
            new DeptRule(Pattern.compile("月经|白带|妇科|怀孕|痛经"), List.of("妇科"), "症状指向妇科"),
            new DeptRule(Pattern.compile("牙|口腔|牙龈|蛀牙"), List.of("口腔科"), "症状指向口腔"),
            new DeptRule(Pattern.compile("眼|视力|看不清|模糊|流泪"), List.of("眼科"), "症状指向眼科"),
            new DeptRule(Pattern.compile("嗓子|咽喉|喉咙|耳朵|鼻|耳鸣|流鼻涕"), List.of("耳鼻咽喉科"), "症状指向耳鼻咽喉")
    );

    private final RedFlagRule redFlagRule;

    public TriageAgent(RedFlagRule redFlagRule) {
        this.redFlagRule = redFlagRule;
    }

    /** 槽位提取 —— 对照 extractSlots */
    public Map<String, String> extractSlots(String text) {
        Map<String, String> slots = new LinkedHashMap<>();
        for (String key : SLOT_KEYS) {
            for (Pattern p : SLOT_PATTERNS.get(key)) {
                java.util.regex.Matcher m = p.matcher(text);
                if (m.find()) { slots.put(key, m.group()); break; }
            }
        }
        return slots;
    }

    /** 合并多轮槽位，后到的非空值覆盖先前的 */
    public Map<String, String> mergeSlots(Map<String, String> base, Map<String, String> next) {
        Map<String, String> out = new LinkedHashMap<>(base);
        for (Map.Entry<String, String> e : next.entrySet()) {
            if (e.getValue() != null && !e.getValue().isEmpty()) out.put(e.getKey(), e.getValue());
        }
        return out;
    }

    /** 还缺哪些最小必要槽位 —— 对照 missingSlots */
    public List<String> missingSlots(Map<String, String> slots, String text) {
        String nature = slots.getOrDefault("性质", "");
        String hay = text + " " + nature;
        boolean locationImplied = SELF_LOCATED.matcher(hay).find();
        boolean isLabQuery = LAB_INDICATOR.matcher(hay).find() && !BODY_COMPLAINT.matcher(hay).find();

        List<String> missing = new ArrayList<>();
        for (String k : REQUIRED_SLOTS) {
            if (k.equals("部位") && locationImplied) continue;
            if (k.equals("部位") && isLabQuery) continue;
            if (k.equals("时长") && isLabQuery) continue;
            String v = slots.get(k);
            if (v == null || v.isEmpty()) { missing.add(k); continue; }
            if (k.equals("时长") && VAGUE_TIME.matcher(v).matches()) { missing.add(k); continue; }
        }
        return missing;
    }

    /** 追问话术 —— 对照 buildQuestion，一次最多问两个 */
    public String buildQuestion(List<String> missing) {
        if (missing.isEmpty()) return "";
        List<String> ask = new ArrayList<>();
        for (String k : missing.subList(0, Math.min(2, missing.size()))) {
            ask.add(QUESTIONS.get(k));
        }
        return String.join("\n", ask);
    }

    /** 科室规则推断 —— 对照 guessDepartments */
    public List<TriagePayload.Department> guessDepartments(Map<String, String> slots, String text) {
        StringBuilder hay = new StringBuilder(text);
        for (String v : slots.values()) {
            if (v != null && !v.isEmpty()) hay.append(' ').append(v);
        }
        String h = hay.toString();
        List<TriagePayload.Department> hits = new ArrayList<>();
        for (DeptRule rule : DEPT_RULES) {
            if (rule.keywords().matcher(h).find()) {
                for (String name : rule.departments()) {
                    if (hits.stream().noneMatch(d -> d.getName().equals(name))) {
                        hits.add(TriagePayload.Department.builder()
                                .name(name).confidence(0.72).reason(rule.reason()).build());
                    }
                }
            }
        }
        if (hits.isEmpty()) {
            List<TriagePayload.Department> fb = new ArrayList<>();
            for (String name : FALLBACK_DEPARTMENTS) {
                fb.add(TriagePayload.Department.builder().name(name).confidence(0.4)
                        .reason("症状描述尚不足以明确指向某个专科，建议先到全科或导诊台评估").build());
            }
            return fb;
        }
        return new ArrayList<>(hits.subList(0, Math.min(3, hits.size())));
    }

    /** 置信度公式 —— 对照 computeConfidence：槽位0.5+科室0.3+描述0.2 */
    public double computeConfidence(Map<String, String> slots, List<TriagePayload.Department> depts) {
        long filled = REQUIRED_SLOTS.stream().filter(k -> slots.get(k) != null && !slots.get(k).isEmpty()).count();
        double reqScore = (double) filled / REQUIRED_SLOTS.size();
        long optionalFilled = SLOT_KEYS.stream().filter(k -> slots.get(k) != null && !slots.get(k).isEmpty()).count();
        double optScore = (double) optionalFilled / SLOT_KEYS.size();
        double slotScore = reqScore * 0.5 + optScore * 0.15;
        double top = depts.isEmpty() ? 0 : depts.get(0).getConfidence();
        double deptScore = top * 0.3;
        double descScore = slots.get("性质") != null && !slots.get("性质").isEmpty() ? 0.05 : 0;
        double raw = slotScore + deptScore + descScore;
        return Math.max(0, Math.min(1, Math.round(raw * 100.0) / 100.0));
    }

    /**
     * 主处理 —— 对照 makeTriage.handle。
     *
     * @param text       用户当前输入
     * @param knownSlots 上一轮已采集槽位
     * @param round      当前追问轮次（从 0 开始）
     * @param analyzeFn  可选 LLM 分析 (text, round) -> {slots, departments}；null = 纯规则
     */
    public AgentOutput<TriagePayload> run(String text, Map<String, String> knownSlots, int round,
                                          BiFunction<String, Integer, LlmAnalysis> analyzeFn) {
        if (knownSlots == null) knownSlots = new LinkedHashMap<>();
        List<AgentEvent> events = new ArrayList<>();

        // 二次红线确认
        RedFlagRule.RedFlagResult red = redFlagRule.check(text);
        if (red.hit() != null) {
            events.add(AgentEvent.builder().type("emergency").redFlag(
                    Map.of("type", red.hit().getType(), "guidance", red.hit().getGuidance())).build());
            return AgentOutput.<TriagePayload>builder()
                    .status(AgentOutput.BLOCKED)
                    .payload(TriagePayload.builder().departments(Collections.emptyList())
                            .redFlag(red.hit()).collectedSymptoms(knownSlots).nextQuestion(null).build())
                    .confidence(1).evidence(Collections.emptyList()).events(events).build();
        }

        // 槽位合并：规则抽取 + 可选 LLM
        Map<String, String> slots = mergeSlots(knownSlots, extractSlots(text));
        List<TriagePayload.Department> departments = new ArrayList<>();
        boolean usedLlm = false;
        if (analyzeFn != null) {
            try {
                LlmAnalysis out = analyzeFn.apply(text, round);
                if (out != null) {
                    slots = mergeSlots(slots, out.slots());
                    departments = out.departments();
                    usedLlm = true;
                }
            } catch (Exception e) {
                log.warn("[分诊] LLM 分析失败，退回规则: {}", e.getMessage());
                usedLlm = false;
            }
        }
        if (departments.isEmpty()) departments = guessDepartments(slots, text);

        List<String> missing = missingSlots(slots, text);
        double confidence = computeConfidence(slots, departments);

        // 低置信：给 Top3 + 兜底，去重
        if (confidence < MIN_CONFIDENCE && departments.size() == 1) {
            List<TriagePayload.Department> extra = new ArrayList<>();
            for (String name : FALLBACK_DEPARTMENTS) {
                if (departments.stream().noneMatch(d -> d.getName().equals(name))) {
                    extra.add(TriagePayload.Department.builder().name(name).confidence(0.4)
                            .reason("作为备选，建议先到导诊台确认").build());
                }
            }
            departments.addAll(extra);
            departments = new ArrayList<>(departments.subList(0, Math.min(3, departments.size())));
        }

        // 最终去重
        Set<String> seen = new LinkedHashSet<>();
        departments.removeIf(d -> !seen.add(d.getName()));

        // 缺槽位且未达上限 → 追问
        if (!missing.isEmpty() && round < MAX_CLARIFY_ROUNDS) {
            String question = buildQuestion(missing);
            events.add(AgentEvent.builder().type("clarify").question(question).missing(missing).build());
            Map<String, Object> degraded = usedLlm ? null
                    : degrade("槽位与科室由本地规则表推算", "rule-table");
            return AgentOutput.<TriagePayload>builder()
                    .status(AgentOutput.NEED_CLARIFY)
                    .payload(TriagePayload.builder().departments(departments).redFlag(null)
                            .collectedSymptoms(slots).nextQuestion(question).build())
                    .confidence(confidence).evidence(Collections.emptyList())
                    .events(events).degraded(degraded).build();
        }

        // 追问到上限仍未集齐
        if (!missing.isEmpty() && round >= MAX_CLARIFY_ROUNDS) {
            events.add(AgentEvent.caveat("已询问 " + MAX_CLARIFY_ROUNDS
                    + " 轮，症状信息仍不完整。以下建议仅供参考，建议直接到门诊导诊台说明情况。"));
        }

        events.add(AgentEvent.builder().type("department_card").departments(
                departments.stream().map(d -> Map.<String, Object>of(
                        "name", d.getName(), "confidence", d.getConfidence(), "reason", d.getReason()))
                        .toList()).build());

        List<Map<String, Object>> evidence = new ArrayList<>();
        for (TriagePayload.Department d : departments) {
            evidence.add(Map.of("type", "rule", "id", "dept:" + d.getName(),
                    "span", List.of(0, d.getReason().length())));
        }
        Map<String, Object> degraded = usedLlm ? null
                : degrade("科室排序由关键词规则表给出", "rule-table");
        return AgentOutput.<TriagePayload>builder()
                .status(AgentOutput.OK)
                .payload(TriagePayload.builder().departments(departments).redFlag(null)
                        .collectedSymptoms(slots).nextQuestion(null).build())
                .confidence(confidence).evidence(evidence).events(events).degraded(degraded).build();
    }

    public AgentOutput<TriagePayload> run(String text) {
        return run(text, new LinkedHashMap<>(), 0, null);
    }

    /** 对照 TS 版 triage.ts 的 degrade(reason, fallback)，stage 固定为 triage */
    private static Map<String, Object> degrade(String reason, String fallback) {
        return AgentOutput.degrade("triage", reason, fallback);
    }

    /** LLM 分析结果（可选注入） */
    public record LlmAnalysis(Map<String, String> slots, List<TriagePayload.Department> departments) {}
}
