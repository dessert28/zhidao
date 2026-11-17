package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.common.BizException;
import com.zhidao.dto.NewRecordRequest;
import com.zhidao.dto.ProfileUpdateRequest;
import com.zhidao.entity.MedicalRecord;
import com.zhidao.entity.PatientProfile;
import com.zhidao.mapper.MedicalRecordMapper;
import com.zhidao.mapper.PatientProfileMapper;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.Year;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 患者档案与就诊记录。
 *
 * <p>这一层是"跨院时间轴"的数据来源：所有查询都按 {@code userId} 收口，
 * 不提供"查所有人的记录"的入口 —— 管理端本轮不排期（见 HANDOFF 三节「本轮不排期」）。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PatientService {

    private final PatientProfileMapper profileMapper;
    private final MedicalRecordMapper recordMapper;
    private final ObjectMapper objectMapper;

    /* ============================ 档案 ============================ */

    /** 取档案；不存在时返回一个"空档案"而不是 404 —— 新用户第一次打开页面不该看到报错 */
    public PatientProfile getProfile(long userId) {
        PatientProfile p = profileMapper.selectOne(
                new LambdaQueryWrapper<PatientProfile>().eq(PatientProfile::getUserId, userId));
        if (p != null) {
            return p;
        }
        PatientProfile empty = new PatientProfile();
        empty.setUserId(userId);
        empty.setAllergyJson("[]");
        empty.setChronicJson("[]");
        empty.setMedicationJson("[]");
        return empty;
    }

    @Transactional
    public PatientProfile updateProfile(long userId, ProfileUpdateRequest req) {
        PatientProfile p = profileMapper.selectOne(
                new LambdaQueryWrapper<PatientProfile>().eq(PatientProfile::getUserId, userId));

        boolean isNew = p == null;
        if (isNew) {
            p = new PatientProfile();
            p.setUserId(userId);
        }

        if (req.birthYear() != null) {
            p.setBirthYear(req.birthYear());
        }
        if (req.gender() != null && !req.gender().isBlank()) {
            String g = req.gender().toUpperCase();
            if (!List.of("MALE", "FEMALE", "OTHER").contains(g)) {
                throw new BizException("性别只能是 MALE / FEMALE / OTHER");
            }
            p.setGender(g);
        }
        // 传了才覆盖：null 表示"这次不改这一项"，而不是"清空"
        // 这两者的区别在表单只提交部分字段时是致命的
        if (req.allergies() != null) {
            p.setAllergyJson(toJson(splitCsv(req.allergies())));
        }
        if (req.medications() != null) {
            p.setMedicationJson(toJson(splitCsv(req.medications())));
        }
        if (req.chronics() != null) {
            p.setChronicJson(toJson(splitCsv(req.chronics())));
        }

        if (isNew) {
            if (p.getAllergyJson() == null) p.setAllergyJson("[]");
            if (p.getChronicJson() == null) p.setChronicJson("[]");
            if (p.getMedicationJson() == null) p.setMedicationJson("[]");
            profileMapper.insert(p);
        } else {
            profileMapper.updateById(p);
        }
        return p;
    }

    /** 年龄由出生年份推算。返回 null 而不是 -1：调用方拿到 null 会显示"未填写"，拿到 -1 会显示"-1 岁" */
    public Integer ageOf(PatientProfile p) {
        if (p == null || p.getBirthYear() == null) {
            return null;
        }
        return Year.now().getValue() - p.getBirthYear();
    }

    /**
     * 把档案里的两段 JSON 解析成数组。
     *
     * <p>解析失败<b>不抛异常</b>：这是展示型接口，某个用户的脏数据
     * 不该让整个档案页打不开。返回空数组并在日志里记一笔。
     */
    public List<String> parseJsonList(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<List<String>>() {
            });
        } catch (JsonProcessingException e) {
            log.warn("档案 JSON 解析失败，按空处理: {}", e.getClass().getSimpleName());
            return List.of();
        }
    }

    /* ============================ 就诊记录 ============================ */

    /**
     * 新增一条就诊记录。
     *
     * <p><b>这个方法接收的 {@code ocrText} 必须是脱敏后的。</b>
     * 调用方（前端 lib/db/upload.ts）在本地 redact() 之后才发过来，
     * 原文只存在浏览器的 IndexedDB 里。
     *
     * <p>为什么在这里再挡一道：如果哪天真有人把原文传上来，
     * 我们无法从内容上分辨（脱敏前后都是中文）。能做的只有
     * 在文档与命名上反复强调，并让字段名本身带警示 ——
     * {@code ocrText} 而不是 {@code rawText} 就是这个用意。
     */
    @Transactional
    public MedicalRecord addRecord(long userId, NewRecordRequest req) {
        MedicalRecord r = new MedicalRecord();
        r.setUserId(userId);
        r.setHospitalCode(req.hospitalCode());
        r.setVisitDate(req.visitDate());
        r.setDepartment(req.department());
        r.setDiagnosisBrief(req.diagnosisBrief());
        r.setOcrText(req.ocrText());
        r.setFileName(req.fileName());
        r.setFileSize(req.fileSize());
        // 上传的都是"患者自己传的"，与后端录入区分开
        r.setSource("UPLOAD");
        recordMapper.insert(r);
        log.info("新增就诊记录 userId={} hospital={} date={}", userId, req.hospitalCode(), req.visitDate());
        return r;
    }

    /** 跨院时间轴：按就诊日期倒序。不做分页 —— 个人病历量级远达不到需要分页 */
    public List<MedicalRecord> listRecords(long userId) {
        return recordMapper.selectList(new LambdaQueryWrapper<MedicalRecord>()
                .eq(MedicalRecord::getUserId, userId)
                .orderByDesc(MedicalRecord::getVisitDate)
                .orderByDesc(MedicalRecord::getId));
    }

    /**
     * 按院区分组。前端画时间轴时按院区上色，需要这个结构。
     *
     * <p>用 {@code LinkedHashMap} 而不是 {@code HashMap}：
     * 院区的顺序会影响图例顺序，每次刷新都变会很烦躁。
     */
    public Map<String, List<MedicalRecord>> groupByHospital(long userId) {
        return listRecords(userId).stream()
                .collect(Collectors.groupingBy(MedicalRecord::getHospitalCode,
                        java.util.LinkedHashMap::new, Collectors.toList()));
    }

    /** 某患者在某院区最近一次就诊日期，提醒引擎用它判断"该复查了" */
    public LocalDate lastVisit(long userId, String department) {
        MedicalRecord r = recordMapper.selectOne(new LambdaQueryWrapper<MedicalRecord>()
                .eq(MedicalRecord::getUserId, userId)
                .eq(MedicalRecord::getDepartment, department)
                .orderByDesc(MedicalRecord::getVisitDate)
                .last("LIMIT 1"));
        return r == null ? null : r.getVisitDate();
    }

    /** 取患者档案（不存在则给空档案）。提醒引擎用它判断慢病与过敏 */
    public PatientProfile profileOf(long userId) {
        return getProfile(userId);
    }

    /* ============================ 内部 ============================ */

    private List<String> splitCsv(String csv) {
        if (csv == null || csv.isBlank()) {
            return List.of();
        }
        return java.util.Arrays.stream(csv.split("[,，、]"))
                .map(String::trim)
                .filter(s -> !s.isEmpty())
                .distinct()
                .toList();
    }

    private String toJson(List<String> list) {
        try {
            return objectMapper.writeValueAsString(list);
        } catch (JsonProcessingException e) {
            // 写不进去说明 list 里有无法序列化的东西；这里只放字符串，理论上到不了
            throw new BizException("档案内容无法保存");
        }
    }
}
