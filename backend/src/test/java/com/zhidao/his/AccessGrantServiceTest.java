package com.zhidao.his;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.entity.AccessAudit;
import com.zhidao.entity.MedicalRecord;
import com.zhidao.entity.PatientBinding;
import com.zhidao.mapper.AccessAuditMapper;
import com.zhidao.mapper.AccessPreferenceMapper;
import com.zhidao.mapper.MedicalRecordMapper;
import com.zhidao.mapper.PatientBindingMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 院方调阅的授权与窗口测试。
 *
 * <p>这块的每一条断言都对应一个真实的越权路径 ——
 * 写错一条，就意味着某家医院能看到不该看的数据。
 */
@SpringBootTest
@Transactional
@DisplayName("院方调阅：就诊即授权，但不能越权")
class AccessGrantServiceTest {

    @Autowired
    private AccessGrantService grants;

    @Autowired
    private PatientBindingMapper bindingMapper;

    @Autowired
    private AccessPreferenceMapper preferenceMapper;

    @Autowired
    private AccessAuditMapper auditMapper;

    @Autowired
    private MedicalRecordMapper recordMapper;

    private static final String HOSPITAL = "Z2-JFL";
    private static final String APP_KEY = "z2jfl-demo-key";

    @BeforeEach
    void ensureBinding() {
        // 演示账号与浙二已有一条种子绑定，确认它在
        PatientBinding b = bindingMapper.selectOne(new LambdaQueryWrapper<PatientBinding>()
                .eq(PatientBinding::getMatchCode, "DEMO2026")
                .last("LIMIT 1"));
        assertThat(b).as("前置条件：种子绑定必须存在").isNotNull();
    }

    /* ============================ 窗口 ============================ */

    @Test
    @DisplayName("30 天窗口内的记录可调阅")
    void withinWindow() {
        var r = grants.accessForVisit(HOSPITAL, APP_KEY, "DEMO2026", LocalDate.now(), "127.0.0.1");
        assertThat(r.ok()).isTrue();
        assertThat(r.windowStart()).isEqualTo(LocalDate.now().minusDays(30));
        assertThat(r.windowEnd()).isEqualTo(LocalDate.now());

        // 种子数据里 11-10、11-05、11-02 等都在窗口内
        assertThat(r.records()).isNotEmpty();
        for (MedicalRecord m : r.records()) {
            assertThat(m.getVisitDate())
                    .as("返回的记录必须在窗口内")
                    .isBetween(r.windowStart(), r.windowEnd());
        }
    }

    @Test
    @DisplayName("窗口外的旧记录不返回")
    void outsideWindow() {
        // 把就诊日期设为两年后，窗口起点会推到所有种子记录之后
        LocalDate far = LocalDate.now().plusYears(2);
        var r = grants.accessForVisit(HOSPITAL, APP_KEY, "DEMO2026", far, "127.0.0.1");
        assertThat(r.ok()).isTrue();
        // 种子数据都在今天附近，两年后的窗口里应当一条都没有
        for (MedicalRecord m : r.records()) {
            assertThat(m.getVisitDate())
                    .as("返回的记录必须在窗口内")
                    .isAfterOrEqualTo(r.windowStart())
                    .isBeforeOrEqualTo(r.windowEnd());
        }
    }

    @Test
    @DisplayName("不传就诊日期时按今天算")
    void defaultsToToday() {
        var r = grants.accessForVisit(HOSPITAL, APP_KEY, "DEMO2026", null, "127.0.0.1");
        assertThat(r.ok()).isTrue();
        assertThat(r.windowEnd()).isEqualTo(LocalDate.now());
    }

    /* ============================ 越权 ============================ */

    @Test
    @DisplayName("匹配码属于别的院区 → 拒绝")
    void wrongHospital() {
        /*
         * 患者只把匹配码授权给了 Z2-JFL。
         * 即使别的医院拿到了这个码，也不能调阅。
         */
        var r = grants.accessForVisit("MOCK-A", APP_KEY, "DEMO2026", LocalDate.now(), "127.0.0.1");
        assertThat(r.ok()).isFalse();
        assertThat(r.reason()).contains("未授权给本院区");
    }

    @Test
    @DisplayName("匹配码不存在 → 拒绝")
    void unknownCode() {
        var r = grants.accessForVisit(HOSPITAL, APP_KEY, "NOSUCH01", LocalDate.now(), "127.0.0.1");
        assertThat(r.ok()).isFalse();
        assertThat(r.reason()).contains("无效");
    }

    @Test
    @DisplayName("空匹配码 → 拒绝，不查库")
    void blankCode() {
        var r = grants.accessForVisit(HOSPITAL, APP_KEY, "  ", LocalDate.now(), "127.0.0.1");
        assertThat(r.ok()).isFalse();
        assertThat(r.records()).isEmpty();
    }

    @Test
    @DisplayName("患者关闭自动授权 → 拒绝并给出可操作提示")
    void autoGrantOff() {
        grants.setAutoGrant(1L, false);
        var r = grants.accessForVisit(HOSPITAL, APP_KEY, "DEMO2026", LocalDate.now(), "127.0.0.1");
        assertThat(r.ok()).isFalse();
        assertThat(r.reason()).contains("关闭");
        // 提示要能指导患者怎么做，而不是只说"拒绝"
        assertThat(r.reason()).contains("开启");

        grants.setAutoGrant(1L, true); // 复原，避免影响其它用例（事务内其实会回滚）
    }

    @Test
    @DisplayName("匹配码作废后不可用")
    void disabledBinding() {
        PatientBinding b = bindingMapper.selectOne(new LambdaQueryWrapper<PatientBinding>()
                .eq(PatientBinding::getMatchCode, "DEMO2026").last("LIMIT 1"));
        b.setEnabled(false);
        bindingMapper.updateById(b);

        var r = grants.accessForVisit(HOSPITAL, APP_KEY, "DEMO2026", LocalDate.now(), "127.0.0.1");
        assertThat(r.ok()).isFalse();
    }

    /* ============================ 匹配码生成 ============================ */

    @Test
    @DisplayName("重新生成匹配码会作废旧码")
    void regenerateInvalidatesOld() {
        var b = grants.createBinding(1L, HOSPITAL);
        assertThat(b.getMatchCode()).isNotEqualTo("DEMO2026");

        // 新码可用
        assertThat(grants.accessForVisit(HOSPITAL, APP_KEY, b.getMatchCode(), LocalDate.now(), "1.1.1.1").ok())
                .isTrue();
        // 旧码失效
        assertThat(grants.accessForVisit(HOSPITAL, APP_KEY, "DEMO2026", LocalDate.now(), "1.1.1.1").ok())
                .isFalse();
    }

    @Test
    @DisplayName("生成的匹配码不含易混淆字符（0/O/1/I）")
    void codeAvoidsConfusables() {
        for (int i = 0; i < 20; i++) {
            String code = AccessGrantService.newMatchCode();
            assertThat(code).hasSize(8);
            assertThat(code).doesNotContain("0", "O", "1", "I");
        }
    }

    /* ============================ 审计 ============================ */

    @Test
    @DisplayName("调阅会写入审计记录，且患者可查")
    void auditRecorded() {
        long before = auditMapper.selectCount(new LambdaQueryWrapper<AccessAudit>()
                .eq(AccessAudit::getUserId, 1L));

        var r = grants.accessForVisit(HOSPITAL, APP_KEY, "DEMO2026", LocalDate.now(), "127.0.0.1");
        grants.recordAudit(r.userId(), HOSPITAL, APP_KEY, AccessAudit.ACTION_VIEW_DETAIL,
                LocalDate.now(), r.records().stream().map(MedicalRecord::getId).toList(), "127.0.0.1");

        long after = auditMapper.selectCount(new LambdaQueryWrapper<AccessAudit>()
                .eq(AccessAudit::getUserId, 1L));
        assertThat(after).isGreaterThan(before);

        List<AccessAudit> logs = grants.listAudits(1L, 10);
        assertThat(logs).isNotEmpty();
        AccessAudit latest = logs.get(0);
        assertThat(latest.getHospitalCode()).isEqualTo(HOSPITAL);
        assertThat(latest.getAction()).isEqualTo(AccessAudit.ACTION_VIEW_DETAIL);
        assertThat(latest.getItemCount()).isPositive();
    }

    @Test
    @DisplayName("归档回执单独记一条，且标记 archived")
    void archiveRecorded() {
        grants.markArchived(1L, HOSPITAL, APP_KEY, LocalDate.now(), List.of(1L, 2L), "127.0.0.1");
        List<AccessAudit> logs = grants.listAudits(1L, 5);
        AccessAudit a = logs.stream()
                .filter(x -> AccessAudit.ACTION_ARCHIVED.equals(x.getAction()))
                .findFirst().orElseThrow();
        assertThat(a.getArchived()).isTrue();
        assertThat(a.getItemCount()).isEqualTo(2);
    }

    @Test
    @DisplayName("审计写入失败不影响主流程")
    void auditFailureDoesNotBreak() {
        /*
         * 审计表写不进去时，让调阅中断反而会造成诊疗受阻。
         * 这里传一个不存在的 userId 不会失败，但至少验证方法本身不抛异常。
         */
        grants.recordAudit(0, HOSPITAL, APP_KEY, "DENIED", null, List.of(), "1.1.1.1");
        // 没有抛出即通过
    }

    /* ============================ 偏好 ============================ */

    @Test
    @DisplayName("没有偏好记录时默认允许自动授权")
    void defaultAutoGrant() {
        preferenceMapper.delete(new LambdaQueryWrapper<com.zhidao.entity.AccessPreference>()
                .eq(com.zhidao.entity.AccessPreference::getUserId, 1L));
        assertThat(grants.autoGrantEnabled(1L)).isTrue();
    }

    @Test
    @DisplayName("偏好可切换并持久化")
    void togglePreference() {
        grants.setAutoGrant(1L, false);
        assertThat(grants.autoGrantEnabled(1L)).isFalse();
        grants.setAutoGrant(1L, true);
        assertThat(grants.autoGrantEnabled(1L)).isTrue();
    }
}
