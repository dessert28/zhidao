package com.zhidao.controller;

import com.zhidao.common.ApiResult;
import com.zhidao.entity.MedicalRecord;
import com.zhidao.entity.PatientProfile;
import com.zhidao.dto.ProfileUpdateRequest;
import com.zhidao.security.CurrentUser;
import com.zhidao.service.PatientService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 患者档案与跨院就诊记录。
 *
 * <p>注意：<b>所有方法都不接受 userId 参数</b>。
 * 身份只来自 {@link CurrentUser#id()}，即经过签名校验的令牌。
 * 这是防 IDOR（越权访问）最基本的做法，也是最容易被写成
 * {@code @RequestParam Long userId} 的地方。
 */
@RestController
@RequestMapping("/api/patient")
@RequiredArgsConstructor
public class PatientController {

    private final PatientService patientService;

    /** 档案 + 推算年龄。年龄由服务端算，避免各客户端各算一遍标准不一 */
    @GetMapping("/profile")
    public ApiResult<Map<String, Object>> profile() {
        long userId = CurrentUser.id();
        PatientProfile p = patientService.getProfile(userId);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("userId", p.getUserId());
        data.put("birthYear", p.getBirthYear());
        data.put("age", patientService.ageOf(p));
        data.put("gender", p.getGender());
        // 存的是 JSON 串，接口给的是数组 —— 调用方不该关心我们的存储格式
        data.put("allergies", patientService.parseJsonList(p.getAllergyJson()));
        data.put("chronics", patientService.parseJsonList(p.getChronicJson()));
        return ApiResult.ok(data);
    }

    @PutMapping("/profile")
    public ApiResult<Map<String, Object>> updateProfile(@Valid @RequestBody ProfileUpdateRequest req) {
        patientService.updateProfile(CurrentUser.id(), req);
        return profile();
    }

    /**
     * 跨院时间轴。
     *
     * <p>返回 {@code records} 与 {@code byHospital} 两份：
     * 时间轴要按时间排，图例要按院区分组，
     * 让前端自己再分一次组等于把同一个逻辑写两遍。
     */
    @GetMapping("/records")
    public ApiResult<Map<String, Object>> records() {
        long userId = CurrentUser.id();
        List<MedicalRecord> list = patientService.listRecords(userId);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("total", list.size());
        data.put("records", list);
        data.put("byHospital", patientService.groupByHospital(userId));
        return ApiResult.ok(data);
    }
}
