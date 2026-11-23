package com.zhidao.agent;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * PII 脱敏测试 —— 用例与期望值来自 TS 版 redact.ts / redact.test.ts 实测输出。
 * 这是隐私边界的兜底，遮错位置比不遮更危险，必须逐字对齐。
 */
class RedactionServiceTest {

    private RedactionService service;

    @BeforeEach
    void setUp() {
        service = new RedactionService();
    }

    @Test
    @DisplayName("身份证：18 位遮蔽，保留首尾各 4 位")
    void idCard() {
        RedactionService.RedactionResult r = service.redact("身份证110101199003071234");
        assertEquals("身份证1101**********1234", r.text());
        assertEquals(1, r.hits().size());
        assertEquals("id_card", r.hits().get(0).type());
    }

    @Test
    @DisplayName("手机号：11 位遮蔽为 138****5678")
    void phone() {
        RedactionService.RedactionResult r = service.redact("手机13812345678");
        assertEquals("手机138****5678", r.text());
        assertEquals("phone", r.hits().get(0).type());
    }

    @Test
    @DisplayName("邮箱：保留前两位")
    void email() {
        assertEquals("邮箱zh***@example.com", service.redact("邮箱zhangsan@example.com").text());
    }

    @Test
    @DisplayName("银行卡：16 位遮蔽，保留首尾各 4 位")
    void bankCard() {
        RedactionService.RedactionResult r = service.redact("卡号6222021234567890");
        assertEquals("卡号6222********7890", r.text());
        assertEquals("bank_card", r.hits().get(0).type());
    }

    @Test
    @DisplayName("病历号：只遮号码，保留标签")
    void medicalRecordNo() {
        RedactionService.RedactionResult r = service.redact("病历号：A1234567");
        assertEquals("病历号：［病历号已遮蔽］", r.text());
        assertEquals("medical_record_no", r.hits().get(0).type());
    }

    @Test
    @DisplayName("住址：带市区前缀才遮蔽")
    void address() {
        RedactionService.RedactionResult r = service.redact("住北京市朝阳区建国路88号");
        assertTrue(r.text().contains("住址已遮蔽"));
        assertFalse(r.text().contains("建国路88号"));
        // 短地址（无市区前缀）不误伤，与 TS 版一致
        assertEquals("我住建国路88号", service.redact("我住建国路88号").text());
    }

    @Test
    @DisplayName("不误伤医疗文本和日常用语")
    void noFalsePositive() {
        List<String> safe = List.of(
                "白天肚子疼", "肚子疼，最近没胃口", "我叫不上来哪里疼",
                "血压 140/90，心率 78", "空腹血糖 7.2 mmol/L",
                "每天吃 1 片，一天三次", "三个月前做过胃镜", "左膝关节疼痛两周");
        for (String text : safe) {
            assertFalse(service.hasPii(text), "不应脱敏: " + text);
        }
    }

    @Test
    @DisplayName("组合场景：多种 PII 全部遮蔽，hits 正序")
    void combined() {
        RedactionService.RedactionResult r = service.redact(
                "手机 13812345678，住北京市朝阳区建国路88号，身份证 330102195003071234");
        assertFalse(r.text().contains("13812345678"));
        assertFalse(r.text().contains("建国路88号"));
        assertFalse(r.text().contains("330102195003071234"));
        assertEquals(List.of("phone", "address", "id_card"),
                r.hits().stream().map(RedactionService.RedactionHit::type).toList());
    }

    @Test
    @DisplayName("倒序替换保证位置不漂移")
    void reverseReplace() {
        RedactionService.RedactionResult r = service.redact("手机13812345678，邮箱ab@cd.com");
        assertTrue(r.text().contains("138****5678"));
        assertTrue(r.text().contains("ab***@cd.com"));
    }

    @Test
    @DisplayName("已被部分遮住的号码也要遮（前4后4仍可定位）")
    void partiallyMaskedPhone() {
        RedactionService.RedactionResult r = service.redact("号码1238********2222");
        assertFalse(r.text().contains("1238********2222"));
        assertTrue(r.text().contains("123****2222"));
    }
}
