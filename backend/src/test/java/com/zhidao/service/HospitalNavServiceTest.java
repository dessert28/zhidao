package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.entity.HospitalPlace;
import com.zhidao.mapper.HospitalPlaceMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 院内导航服务测试。
 *
 * <p>这里测的不是"接口能不能返回数据"，而是**顺序对不对**。
 * 顺序错了会产生真实后果：让患者先见医生再抽血，医生看诊时没有
 * 当天的检验结果，那一趟就白跑了。所以顺序是业务规则，不是展示细节。
 */
@SpringBootTest
@DisplayName("院内导航：路线顺序与状态判定")
class HospitalNavServiceTest {

    @Autowired
    private HospitalNavService navService;

    @Autowired
    private HospitalPlaceMapper placeMapper;

    /** 明天的 09:30 —— 用相对时间，避免写死日期后过期 */
    private LocalDateTime tomorrow930() {
        return LocalDateTime.now().plusDays(1).withHour(9).withMinute(30).withSecond(0).withNano(0);
    }

    @BeforeEach
    void ensureData() {
        // 前置条件：样例院区的数据必须在，否则后面的断言失败原因会很难查
        long n = navService.countPlaces("Z2-JFL");
        assertThat(n)
                .as("前置条件：Z2-JFL 的院内地点数据应已由 data.sql 灌入")
                .isGreaterThan(0);
    }

    /* ============================ 顺序 ============================ */

    @Test
    @DisplayName("空腹场景：抽血排在见医生之前")
    void fastingLabBeforeClinic() {
        List<HospitalNavService.RouteStep> route =
                navService.buildRoute("Z2-JFL", "内分泌科", true, false, tomorrow930(), LocalDateTime.now());

        int labIdx = -1;
        int clinicIdx = -1;
        for (int i = 0; i < route.size(); i++) {
            if ("LAB".equals(route.get(i).stage())) labIdx = i;
            if ("CLINIC".equals(route.get(i).stage())) clinicIdx = i;
        }

        assertThat(labIdx).as("应有检验步骤").isGreaterThanOrEqualTo(0);
        assertThat(clinicIdx).as("应有诊区步骤").isGreaterThanOrEqualTo(0);
        assertThat(labIdx)
                .as("抽血必须在看诊前 —— 否则医生拿不到当天结果")
                .isLessThan(clinicIdx);
    }

    @Test
    @DisplayName("挂号永远是第一步")
    void registerIsFirst() {
        List<HospitalNavService.RouteStep> route =
                navService.buildRoute("Z2-JFL", "内分泌科", true, false, tomorrow930(), LocalDateTime.now());
        assertThat(route.get(0).stage()).isEqualTo("REGISTER");
    }

    @Test
    @DisplayName("取药是最后一步")
    void pharmacyIsLast() {
        List<HospitalNavService.RouteStep> route =
                navService.buildRoute("Z2-JFL", "内分泌科", true, false, tomorrow930(), LocalDateTime.now());
        assertThat(route.get(route.size() - 1).stage()).isEqualTo("PHARMACY");
    }

    @Test
    @DisplayName("step 编号连续，从 1 开始")
    void stepOrdersAreConsecutive() {
        List<HospitalNavService.RouteStep> route =
                navService.buildRoute("Z2-JFL", "内分泌科", true, false, tomorrow930(), LocalDateTime.now());
        for (int i = 0; i < route.size(); i++) {
            assertThat(route.get(i).order()).isEqualTo(i + 1);
        }
    }

    /* ============================ 状态 ============================ */

    @Test
    @DisplayName("预约在明天：第一步是 CURRENT，其余 UPCOMING")
    void tomorrowVisitOnlyFirstIsCurrent() {
        List<HospitalNavService.RouteStep> route =
                navService.buildRoute("Z2-JFL", "内分泌科", true, false, tomorrow930(), LocalDateTime.now());

        assertThat(route.get(0).status()).isEqualTo("CURRENT");
        for (int i = 1; i < route.size(); i++) {
            assertThat(route.get(i).status())
                    .as("第 " + (i + 1) + " 步应为 UPCOMING")
                    .isEqualTo("UPCOMING");
        }
    }

    @Test
    @DisplayName("预约时间已过：前面的步骤标 DONE（不是全 CURRENT）")
    void pastStepsAreDone() {
        // 预约在 3 小时前 —— 挂号、抽血、看诊都该已完成
        LocalDateTime visit = LocalDateTime.now().minusHours(3);
        List<HospitalNavService.RouteStep> route =
                navService.buildRoute("Z2-JFL", "内分泌科", true, false, visit, LocalDateTime.now());

        long doneCount = route.stream().filter(s -> "DONE".equals(s.status())).count();
        assertThat(doneCount)
                .as("预约时间已过时，至少有挂号这一步应该是 DONE")
                .isGreaterThan(0);

        /*
         * 这一条是实测缺陷的回归：第一版把所有步骤里第一个标 CURRENT、
         * 其余全 UPCOMING，导致已经办完和还没到的看起来一模一样。
         */
        assertThat(route.get(0).status())
                .as("挂号那一步应该已经做完了")
                .isEqualTo("DONE");
    }

    @Test
    @DisplayName("任何时刻必定有且只有一个 CURRENT")
    void exactlyOneCurrent() {
        for (int hoursAgo : new int[]{-6, -2, 0, 2, 6}) {
            LocalDateTime visit = LocalDateTime.now().plusHours(hoursAgo);
            List<HospitalNavService.RouteStep> route =
                    navService.buildRoute("Z2-JFL", "内分泌科", true, false, visit, LocalDateTime.now());
            long cur = route.stream().filter(s -> "CURRENT".equals(s.status())).count();
            assertThat(cur)
                    .as("预约时间偏移 " + hoursAgo + " 小时时，CURRENT 应恰好 1 个")
                    .isEqualTo(1);
        }
    }

    /* ============================ 当前步骤 ============================ */

    @Test
    @DisplayName("现在该去哪：提前两小时到院应该去挂号")
    void currentStepWhenArrivedEarly() {
        LocalDateTime visit = LocalDateTime.now().plusHours(2);
        Optional<HospitalNavService.RouteStep> step =
                navService.currentStep("Z2-JFL", "内分泌科", true, visit, LocalDateTime.now());
        assertThat(step).isPresent();
        assertThat(step.get().stage()).isEqualTo("REGISTER");
    }

    /* ============================ 科室差异 ============================ */

    @Test
    @DisplayName("不同科室给不同的诊区位置")
    void differentDepartmentsDifferentClinics() {
        LocalDateTime visit = tomorrow930();

        var endocrine = navService.buildRoute("Z2-JFL", "内分泌科", true, false, visit, LocalDateTime.now())
                .stream().filter(s -> "CLINIC".equals(s.stage())).findFirst();
        var dermatology = navService.buildRoute("Z2-JFL", "皮肤科", false, false, visit, LocalDateTime.now())
                .stream().filter(s -> "CLINIC".equals(s.stage())).findFirst();

        assertThat(endocrine).isPresent();
        assertThat(dermatology).isPresent();
        assertThat(endocrine.get().place().getFloor())
                .as("内分泌在三楼、皮肤科在五楼 —— 换了科室路线要跟着变")
                .isNotEqualTo(dermatology.get().place().getFloor());
    }

    @Test
    @DisplayName("通用地点对所有科室都出现（挂号处、药房不能漏）")
    void commonPlacesAppearForEveryDepartment() {
        for (String dept : new String[]{"内分泌科", "皮肤科", "骨科"}) {
            List<HospitalNavService.RouteStep> route =
                    navService.buildRoute("Z2-JFL", dept, false, false, tomorrow930(), LocalDateTime.now());
            assertThat(route.stream().map(HospitalNavService.RouteStep::stage))
                    .as(dept + " 的路线应包含挂号与取药")
                    .contains("REGISTER", "PHARMACY");
        }
    }

    /* ============================ 数据质量 ============================ */

    @Test
    @DisplayName("样例数据必须标 SAMPLE —— 不能把示意楼层当成真实导航")
    void sampleDataIsMarked() {
        List<HospitalPlace> places = navService.listByHospital("Z2-JFL");
        assertThat(places).isNotEmpty();
        assertThat(places)
                .as("当前所有浙二样例地点都应为 SAMPLE；若将来换成院方数据，改成 REAL 并更新此断言")
                .allMatch(p -> "SAMPLE".equals(p.getDataQuality()));
    }

    /* ============================ 边界 ============================ */

    @Test
    @DisplayName("未配置的院区返回空路线，而不是报错")
    void unknownHospitalReturnsEmpty() {
        List<HospitalNavService.RouteStep> route =
                navService.buildRoute("NO-SUCH", "内分泌科", true, false, tomorrow930(), LocalDateTime.now());
        assertThat(route).isEmpty();
    }

    @Test
    @DisplayName("科室没有专属诊区时，仍给出通用地点")
    void unknownDepartmentStillGetsCommonPlaces() {
        List<HospitalNavService.RouteStep> route =
                navService.buildRoute("Z2-JFL", "眼科", false, false, tomorrow930(), LocalDateTime.now());
        // 眼科没配诊区，但挂号处、药房这些通用地点应该在
        assertThat(route).isNotEmpty();
        assertThat(route.stream().map(HospitalNavService.RouteStep::stage))
                .doesNotContain("CLINIC");
    }

    @Test
    @DisplayName("关闭时间粗判：营业时间外提示可能已关门")
    void closedDetection() {
        HospitalPlace p = new HospitalPlace();
        p.setOpenHours("周一至周六 7:30-16:00");

        // 15:00 应判定为未关门
        assertThat(HospitalNavService.maybeClosed(p, LocalDateTime.now().withHour(15).withMinute(0)))
                .isFalse();
        // 17:00 应判定为可能已关门
        assertThat(HospitalNavService.maybeClosed(p, LocalDateTime.now().withHour(17).withMinute(0)))
                .isTrue();
    }

    @Test
    @DisplayName("openHours 为空时不误报关门")
    void noHoursNoFalseAlarm() {
        HospitalPlace p = new HospitalPlace();
        p.setOpenHours(null);
        assertThat(HospitalNavService.maybeClosed(p, LocalDateTime.now())).isFalse();
    }
}
