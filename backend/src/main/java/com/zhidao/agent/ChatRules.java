package com.zhidao.agent;

import com.zhidao.agent.contract.TriagePayload;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 对话前置规则 —— 对照 frontend/server/agents/rules/injection.ts + topic.ts。
 *
 * <p>提示词注入检测、情绪主诉识别、话题切换判定都是确定性规则，
 * 在 Supervisor 决策之前运行。逐字对齐 TS 版正则与文案。
 */
@Component
public class ChatRules {

    /** 注入检测信号 */
    public record InjectionSignal(String hit, String matched) {}

    private record InjectPattern(String name, Pattern re) {}
    private static final List<InjectPattern> INJECTION_PATTERNS = List.of(
            new InjectPattern("override_instructions",
                    Pattern.compile("(忽略|无视|忘记|忘掉|抛开|别管)[^，。]{0,8}(指令|提示词|规则|设定|要求|限制|约束)")),
            new InjectPattern("role_switch",
                    Pattern.compile("(你现在|从现在开始|接下来|从此)[^，。]{0,8}(是|扮演|变成|作为)[^，。]{0,12}(角色|AI|模型|助手|机器人|不受限|不受限制)")),
            new InjectPattern("forced_output",
                    Pattern.compile("(只|仅)(能|能就|需要)?(输出|回答|回复|说|重复)[^，。]{0,6}(字母|字符|「|\"|')")),
            new InjectPattern("prompt_leak",
                    Pattern.compile("(告诉我|输出|显示|打印|泄露|复述|重复)[^，。]{0,6}(系统)?(提示词|prompt|指令|设定)[^，。]{0,4}(原文|内容|全文)?")),
            new InjectPattern("jailbreak",
                    Pattern.compile("(不受|没有|去除|解除|去掉)[^，。]{0,4}(限制|约束|审查|过滤)")
            ));

    /** 检测指令注入 —— 对照 detectInjection */
    public List<InjectionSignal> detectInjection(String text) {
        List<InjectionSignal> out = new ArrayList<>();
        for (InjectPattern ip : INJECTION_PATTERNS) {
            Matcher m = ip.re().matcher(text);
            if (m.find()) out.add(new InjectionSignal(ip.name(), m.group()));
        }
        return out;
    }

    public boolean looksLikeInjection(String text) {
        return !detectInjection(text).isEmpty();
    }

    /** 剥掉注入句式，留下真实需求 —— 对照 stripInjectionSentences */
    public String stripInjectionSentences(String text) {
        String[] sentences = text.split("(?<=[。！？；\\n])");
        StringBuilder out = new StringBuilder();
        for (String s : sentences) if (!looksLikeInjection(s)) out.append(s);
        return out.toString().trim();
    }

    private static final Pattern EMOTION_PATTERN = Pattern.compile(
            "失恋|分手|离婚|被甩|暗恋|单相思|喜欢的人|心碎|难过|难受想哭|想哭|哭了|心情不好|心情低落|情绪低落|心里堵|心里难受|心里不舒服|抑郁|焦虑|压力(大|很大|好大|太大)|撑不住|受不了|崩溃|烦躁|靠谱吗.*(恋爱|感情)|感情(问题|困扰)|男朋友|女朋友|对象.*(分手|吵架)");

    public record EmotionSignal(boolean hit, String matched) {}

    /** 情绪主诉识别 —— 对照 detectEmotion */
    public EmotionSignal detectEmotion(String text) {
        Matcher m = EMOTION_PATTERN.matcher(text);
        return m.find() ? new EmotionSignal(true, m.group()) : new EmotionSignal(false, null);
    }

    private static final Pattern NEW_COMPLAINT = Pattern.compile(
            "头晕|头疼|头痛|胸闷|心慌|心悸|发烧|发热|咳嗽|咳痰|呕吐|腹泻|皮疹|尿频|尿痛|关节疼|腰疼|膝盖疼");

    /** 话题切换判定 —— 对照 isTopicSwitch */
    public boolean isTopicSwitch(String text, Map<String, String> knownSlots) {
        if (detectEmotion(text).hit()) return true;
        Matcher m = NEW_COMPLAINT.matcher(text);
        if (!m.find()) return false;
        String knownBlob = String.join(" ", knownSlots.values());
        String hit = m.group();
        return !knownBlob.contains(hit.substring(0, Math.min(2, hit.length())));
    }

    /**
     * 是否像"知识提问"（问检查、问原因、问怎么办），而不是补充症状。
     *
     * <p>解决的是真机遇到的一个死结：分诊追问阶段（round&gt;0）编排器会无条件
     * 短路成"继续采集症状"，于是用户问「检查原因」「要做什么检查」这种问题时，
     * 系统仍然当他在补症状 —— 抽不到新槽位，就把同一段科室建议再念一遍，
     * 用户看到的是"每句话都回同一段"。后台其实每次都调了模型，只是模型
     * 根本没被问到这个问题。
     *
     * <p>判据刻意保守：只认"疑问特征词 + 不含新症状描述"。
     * 用户答「好久了」「有点恶心」不会命中；答「头晕要做哪些检查」会命中，
     * 交回 Supervisor 走检索分支。
     */
    private static final Pattern KNOWLEDGE_QUESTION = Pattern.compile(
            "做什么检查|做哪些检查|查什么|检查什么|检查原因|怎么检查|什么原因|为什么|怎么回事"
                    + "|怎么办|怎么治|如何治|要不要|能不能|可以吗|严重吗|要紧吗|会好吗|多久能好"
                    + "|注意什么|注意哪些|吃什么药|用什么药|挂哪个?科|看什么科|需不需要");

    public boolean looksLikeKnowledgeQuestion(String text) {
        if (text == null || text.length() < 2) return false;
        if (!KNOWLEDGE_QUESTION.matcher(text).find()) return false;
        // 纯症状补充句（"头晕得厉害怎么办"这种仍算提问；"头很晕"不含疑问词，已排除）
        return true;
    }

    /* 情绪路径常量 —— 对照 topic.ts */
    public static final String EMOTION_COMFORT =
            "听你这么说，这段时间心里肯定不好受。这种难受是真实的，也值得被认真对待，不用一个人硬扛。";
    public static final String EMOTION_CAVEAT =
            "如果这些感受已经持续两周以上，或伴随持续失眠、食欲明显改变、无法缓解的胸闷心慌，"
                    + "建议到临床心理科或精神卫生科评估；也可以先到全科排查身体原因。"
                    + "如果出现伤害自己的念头，请尽快联系家人朋友陪同就医，或拨打心理援助热线（如 12356）。";

    /** 占位词判定 —— 对照 chat.ts isPlaceholderValue */
    private static final Set<String> PLACEHOLDERS = Set.of(
            "未提及", "不详", "无", "没有", "未知", "不清楚", "不知道", "无特殊", "正常", "N/A", "n/a");
    public boolean isPlaceholderValue(String v) {
        return PLACEHOLDERS.contains(v.trim());
    }

    /** 分诊摘要 —— 逐字对照 chat.ts summarizeTriage */
    public String summarizeTriage(List<TriagePayload.Department> departments) {
        if (departments == null || departments.isEmpty())
            return "暂时无法判断该挂哪个科，建议到门诊导诊台说明情况。";
        TriagePayload.Department top = departments.get(0);
        String main = "建议优先挂「" + top.getName() + "」，依据是" + top.getReason() + "。";
        if (departments.size() == 1) return main;
        StringBuilder others = new StringBuilder();
        for (int i = 1; i < departments.size(); i++) {
            if (i > 1) others.append("」或「");
            others.append(departments.get(i).getName());
        }
        return main + "如果挂号有困难，也可以先到「" + others + "」或门诊导诊台评估。";
    }
}
