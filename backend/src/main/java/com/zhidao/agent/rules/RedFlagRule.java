package com.zhidao.agent.rules;

import com.zhidao.agent.contract.RedFlag;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.regex.Pattern;

/**
 * 红线规则引擎 —— 逐条对照 frontend/server/agents/rules/red-flag.ts。
 *
 * <p>纯正则、零 LLM、零外部依赖。命中即短路：胸痛/卒中/呼吸困难/意识改变/大出血
 * 直接输出紧急指引并终止本轮。这是 Reviewer safety 维度的前置防线，
 * 也是"AI 安全与可控性"最硬的证据 —— 不能赌模型是否配合，所以用确定性规则。
 *
 * <p>正则与 TS 版逐字一致（Java 与 JS 的正则语法在这些表达式上兼容），
 * guidance 文案逐字一致，保证迁移后行为完全对齐。
 */
@Slf4j
@Component
public class RedFlagRule {

    private record Rule(String type, List<Pattern> patterns, String guidance) {}

    private static final List<Rule> RULES = List.of(
            new Rule("chest_pain", List.of(
                    Pattern.compile("胸(口|部|前区|骨后)?(疼|痛|闷|压|堵)"),
                    Pattern.compile("心(口窝|前区)(疼|痛|闷)"),
                    Pattern.compile("(压榨|憋闷).{0,6}(疼|痛)"),
                    Pattern.compile("(急性)?心(肌)?梗(死)?"),
                    Pattern.compile("急性冠脉综合征")
            ), "胸痛可能是心梗信号。请立即停止活动、原地坐下或半卧，不要自行开车前往。"
                    + "拨打 120 或让身边的人送你去最近医院急诊。"
                    + "若手边有硝酸甘油且是医生开给你的，可按既往医嘱舌下含服。"),

            new Rule("stroke", List.of(
                    Pattern.compile("(口角|嘴角|嘴).{0,4}(歪|斜|漏水)"),
                    Pattern.compile("(一侧|半边|单侧|一边|左边|右边|左侧|右侧).{0,6}(无力|没力气|没劲|使不上|抬不起|不能动|发麻|麻)"),
                    Pattern.compile("(无力|没力气|使不上劲).{0,6}(一侧|半边|单侧|一边|左边|右边|左侧|右侧)"),
                    Pattern.compile("(说话|言语|讲话).{0,4}(不清|含糊|说不|不利)"),
                    Pattern.compile("(突然).{0,6}(看不见|失明|视物)")
            ), "这些是卒中（中风）的典型表现，抢救有黄金时间窗。请立即拨打 120，"
                    + "告知接线员\"怀疑卒中\"及最后一次正常的时间。不要让患者自行服药或进食。"),

            new Rule("dyspnea", List.of(
                    Pattern.compile("(喘不(上|过)|呼吸(困难|急促|费劲)|气(短|促|不够用))"),
                    Pattern.compile("(憋气|吸不进气|上不来气)")
            ), "呼吸困难需要立即评估。请让患者取坐位或半卧位、解开领口，保持通风。"
                    + "若出现口唇发紫、不能完整说话，立即拨打 120。"),

            new Rule("consciousness", List.of(
                    Pattern.compile("(意识(不清|模糊)|昏迷|叫不醒|晕倒|昏过去)"),
                    Pattern.compile("(抽搐|抽风|口吐白沫|全身抽)"),
                    Pattern.compile("(突然).{0,4}(倒地|人事不省)")
            ), "意识改变属于急危重症。若患者无反应且无正常呼吸，立即拨打 120 并开始胸外按压（120 调度员会电话指导）。"
                    + "若抽搐，移开周围硬物、不要强行按压肢体或往口中塞任何东西。"),

            new Rule("hemorrhage", List.of(
                    Pattern.compile("(大出血|出血不止|血(流)?不停)"),
                    Pattern.compile("(呕血|吐血|咯血|咳血)"),
                    Pattern.compile("(黑便|柏油(样)?便|便血)"),
                    Pattern.compile("(产后|术后).{0,6}(出血|血多)")
            ), "活动性大出血需要急诊处理。请用干净布料直接压迫出血部位并抬高患处，立即拨打 120。"
                    + "呕血或黑便提示消化道出血，请保持禁食禁水并尽快就医。")
    );

    public record RedFlagResult(RedFlag hit, List<String> matchedTypes) {}

    /** 执行红线检查 —— 纯函数，对照 checkRedFlag */
    public RedFlagResult check(String text) {
        List<String> matched = new ArrayList<>();
        RedFlag hit = null;
        for (Rule rule : RULES) {
            if (matched.contains(rule.type())) continue;
            boolean any = false;
            for (Pattern p : rule.patterns()) {
                if (p.matcher(text).find()) { any = true; break; }
            }
            if (any) {
                matched.add(rule.type());
                if (hit == null) hit = RedFlag.builder().type(rule.type()).guidance(rule.guidance()).build();
            }
        }
        return new RedFlagResult(hit, matched);
    }

    /** 供 Reviewer 复检：答案里出现急症词也要追加提示 */
    public RedFlag recheckAnswer(String answer) {
        return check(answer).hit();
    }

    public int ruleCount() {
        return RULES.size();
    }
}
