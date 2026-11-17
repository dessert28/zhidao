package com.zhidao.controller;

import com.zhidao.entity.HospitalPlace;
import com.zhidao.service.HospitalNavService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * navKeyOf 的规则测试。
 *
 * <p>这个方法是前后端约定的唯一凭据：前端用同一套规则生成 key，
 * 后端用它查标记。两边不一致的表现是"点了标记却没反应"——
 * 因为它标到另一个 key 上去了，而这种 bug 不看代码根本查不出来。
 *
 * <p>所以这里把规则钉死。前端 `api.ts` 的 `navKeyOf` 必须与之逐字一致。
 */
class NavKeyRuleTest {

    private HospitalNavService.RouteStep step(String stage, String department) {
        HospitalPlace p = new HospitalPlace();
        p.setPlaceType(stage);
        p.setDepartment(department);
        p.setName("测试地点");
        return new HospitalNavService.RouteStep(1, stage, "阶段", p, "CURRENT", "");
    }

    @Test
    @DisplayName("无科室的步骤只用阶段编码")
    void withoutDepartment() {
        assertEquals("REGISTER", NavController.navKeyOf(step("REGISTER", null)));
    }

    @Test
    @DisplayName("有科室的步骤带上科室后缀，避免不同科室撞 key")
    void withDepartment() {
        assertEquals("CLINIC:内分泌科", NavController.navKeyOf(step("CLINIC", "内分泌科")));
    }

    @Test
    @DisplayName("空白科室等同于没有科室")
    void blankDepartmentTreatedAsAbsent() {
        /*
         * 数据库里 department 可能是空串而不是 NULL（历史数据常见）。
         * 不处理这种情况会生成 "CLINIC:" 这种带冒号的 key，
         * 和前端生成的 "CLINIC" 对不上。
         */
        assertEquals("CLINIC", NavController.navKeyOf(step("CLINIC", "   ")));
    }

    @Test
    @DisplayName("两个不同科室的诊区不会撞 key")
    void differentDepartmentsDiffer() {
        String a = NavController.navKeyOf(step("CLINIC", "内分泌科"));
        String b = NavController.navKeyOf(step("CLINIC", "心血管内科"));
        // 撞 key 的话，标记了一个科室的看诊，另一个科室也会显示已完成
        org.junit.jupiter.api.Assertions.assertNotEquals(a, b);
    }
}
