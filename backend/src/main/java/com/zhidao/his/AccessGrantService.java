package com.zhidao.his;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.entity.AccessAudit;
import com.zhidao.entity.AccessPreference;
import com.zhidao.entity.MedicalRecord;
import com.zhidao.entity.PatientBinding;
import com.zhidao.mapper.AccessAuditMapper;
import com.zhidao.mapper.AccessPreferenceMapper;
import com.zhidao.mapper.MedicalRecordMapper;
import com.zhidao.mapper.PatientBindingMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * 院方调阅 —— 就诊即授权。
 *
 * <h3>这套设计要解决的核心矛盾</h3>
 *
 * <p>患者去医院就诊，本身就代表授权医生查看相关病历；
 * 再让他掏手机点一次「同意」，是把系统责任推给用户，
 * 老年患者根本操作不了。
 *
 * <p>所以授权门槛不设在患者端，而设在**院方请求**这一侧：
 * <ul>
 *   <li>必须来自已认证的院区 appKey</li>
 *   <li>必须能对上一位真实存在的患者（匹配码）</li>
 *   <li>必须落在一个合法的就诊时间窗内</li>
 *   <li>每次都留痕，患者事后可查</li>
 * </ul>
 *
 * <h3>窗口为什么是 30 天</h3>
 *
 * <p>覆盖真实的复诊节奏 —— 多数慢病医嘱是「1 个月后复查」，
 * 医生那时候需要看到上次的报告做对比。同时又不至于
 * 「一次挂号终身可查」。窗口可通过配置调整。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AccessGrantService {

    private final PatientBindingMapper bindingMapper;
    private final AccessPreferenceMapper preferenceMapper;
    private final AccessAuditMapper auditMapper;
    private final MedicalRecordMapper recordMapper;

    /**
     * 访问窗口（天）。默认 30。
     *
     * <p>含义：以 HIS 传来的就诊日期为基准，往前推这么天内
     * 的医疗记录可被该院方调阅。超出窗口的记录一律不返回 ——
     * 医生看这次就诊相关的资料是必要的，翻三年前的记录不是。
     */
    @Value("${zhidao.access.window-days:30}")
    private int windowDays;

    /* ============================ 匹配码 ============================ */

    /** 生成一个易读的匹配码：8 位大写字母数字，去掉易混淆的 0/O/1/I */
    private static final String ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private static final SecureRandom RANDOM = new SecureRandom();

    public static String newMatchCode() {
        StringBuilder sb = new StringBuilder(8);
        for (int i = 0; i < 8; i++) {
            sb.append(ALPHABET.charAt(RANDOM.nextInt(ALPHABET.length())));
        }
        return sb.toString();
    }

    /** 为患者生成（或重新生成）与某院区的绑定 */
    public PatientBinding createBinding(long userId, String hospitalCode) {
        // 同一院区只保留一条有效绑定，重生成时旧的作废
        PatientBinding old = bindingMapper.selectOne(new LambdaQueryWrapper<PatientBinding>()
                .eq(PatientBinding::getUserId, userId)
                .eq(PatientBinding::getHospitalCode, hospitalCode)
                .eq(PatientBinding::getEnabled, true)
                .last("LIMIT 1"));
        if (old != null) {
            old.setEnabled(false);
            bindingMapper.updateById(old);
        }

        PatientBinding b = new PatientBinding();
        b.setUserId(userId);
        b.setHospitalCode(hospitalCode);
        b.setMatchCode(newMatchCode());
        b.setEnabled(true);
        bindingMapper.insert(b);
        return b;
    }

    /** 患者当前的绑定列表 */
    public List<PatientBinding> listBindings(long userId) {
        return bindingMapper.selectList(new LambdaQueryWrapper<PatientBinding>()
                .eq(PatientBinding::getUserId, userId)
                .eq(PatientBinding::getEnabled, true)
                .orderByDesc(PatientBinding::getCreatedAt));
    }

    /* ============================ 授权偏好 ============================ */

    /** 读取偏好，没有记录时返回默认值 true（不落库） */
    public boolean autoGrantEnabled(long userId) {
        AccessPreference p = preferenceMapper.selectOne(new LambdaQueryWrapper<AccessPreference>()
                .eq(AccessPreference::getUserId, userId)
                .last("LIMIT 1"));
        return p == null || Boolean.TRUE.equals(p.getAutoGrant());
    }

    /** 设置偏好（首次调用时插入） */
    public void setAutoGrant(long userId, boolean enabled) {
        AccessPreference p = preferenceMapper.selectOne(new LambdaQueryWrapper<AccessPreference>()
                .eq(AccessPreference::getUserId, userId)
                .last("LIMIT 1"));
        if (p == null) {
            p = new AccessPreference();
            p.setUserId(userId);
            p.setAutoGrant(enabled);
            preferenceMapper.insert(p);
        } else {
            p.setAutoGrant(enabled);
            preferenceMapper.updateById(p);
        }
    }

    /* ============================ 调阅 ============================ */

    /** 调阅结果 */
    public record AccessResult(
            boolean ok,
            String reason,
            long userId,
            List<MedicalRecord> records,
            LocalDate windowStart,
            LocalDate windowEnd
    ) {
        static AccessResult fail(String reason) {
            return new AccessResult(false, reason, 0, List.of(), null, null);
        }
    }

    /**
     * 院方调阅某患者在某次就诊时间窗内的记录。
     *
     * <p>校验顺序刻意是：匹配码 → 偏好 → 窗口。先做能快速否定的检查，
     * 最后才查数据 —— 拒绝路径上不产生任何数据读取。
     *
     * @param hospitalCode 凭据绑定的院区（不是请求里的，防越权）
     * @param matchCode    院方从 HIS 里读到的匹配码
     * @param visitDate    本次就诊日期；为空时按今天算
     * @param ip           调用方 IP，用于审计
     */
    public AccessResult accessForVisit(
            String hospitalCode, String appKey, String matchCode,
            LocalDate visitDate, String ip) {

        if (matchCode == null || matchCode.isBlank()) {
            return AccessResult.fail("缺少 matchCode（患者匹配码）");
        }

        // 1. 匹配码必须存在、启用、且属于该院区
        PatientBinding binding = bindingMapper.selectOne(new LambdaQueryWrapper<PatientBinding>()
                .eq(PatientBinding::getMatchCode, matchCode.trim().toUpperCase())
                .eq(PatientBinding::getEnabled, true)
                .last("LIMIT 1"));
        if (binding == null) {
            return AccessResult.fail("匹配码无效或已作废");
        }
        if (!binding.getHospitalCode().equals(hospitalCode)) {
            /*
             * 这一条是防越权的关键：A 医院的匹配码即使在 B 医院被录入，
             * B 医院也调不到数据 —— 患者只授权给了 A。
             */
            return AccessResult.fail("该匹配码未授权给本院区");
        }

        // 2. 患者是否允许自动授权
        if (!autoGrantEnabled(binding.getUserId())) {
            return AccessResult.fail(
                    "患者已关闭就诊期间的自动授权。请让患者在「智诊通 → 隐私设置」中开启，"
                            + "或由患者本人出示就诊摘要。");
        }

        // 3. 窗口计算
        LocalDate base = visitDate == null ? LocalDate.now() : visitDate;
        LocalDate windowEnd = base;
        LocalDate windowStart = base.minusDays(windowDays);

        // 4. 取窗口内的记录
        List<MedicalRecord> all = recordMapper.selectList(
                new LambdaQueryWrapper<MedicalRecord>()
                        .eq(MedicalRecord::getUserId, binding.getUserId())
                        .ge(MedicalRecord::getVisitDate, windowStart)
                        .le(MedicalRecord::getVisitDate, windowEnd)
                        .orderByDesc(MedicalRecord::getVisitDate));

        return new AccessResult(true, "", binding.getUserId(), all, windowStart, windowEnd);
    }

    /* ============================ 审计 ============================ */

    /**
     * 写一条审计记录。
     *
     * <p>失败只记日志、不影响业务 —— 审计表写不进去时，
     * 让调阅中断反而会造成诊疗受阻；但异常必须能被运维看到。
     */
    public void recordAudit(
            long userId, String hospitalCode, String appKey, String action,
            LocalDate visitDate, List<Long> recordIds, String ip) {

        try {
            AccessAudit a = new AccessAudit();
            a.setUserId(userId);
            a.setHospitalCode(hospitalCode);
            a.setAppKey(appKey);
            a.setAction(action);
            a.setVisitDate(visitDate);
            List<Long> ids = recordIds == null ? List.of() : recordIds;
            a.setItemCount(ids.size());
            a.setRecordIds(ids.isEmpty() ? null : joinIds(ids));
            a.setArchived(AccessAudit.ACTION_ARCHIVED.equals(action));
            a.setClientIp(ip);
            auditMapper.insert(a);
        } catch (RuntimeException e) {
            log.error("[access] 审计写入失败 user={} hospital={} action={}",
                    userId, hospitalCode, action, e);
        }
    }

    private static String joinIds(List<Long> ids) {
        StringBuilder sb = new StringBuilder();
        for (Long id : ids) {
            if (sb.length() > 0) sb.append(',');
            sb.append(id);
            if (sb.length() > 900) break; // 列宽 1000，留余量
        }
        return sb.toString();
    }

    /** 患者查看自己的访问记录 */
    public List<AccessAudit> listAudits(long userId, int limit) {
        return auditMapper.selectList(new LambdaQueryWrapper<AccessAudit>()
                .eq(AccessAudit::getUserId, userId)
                .orderByDesc(AccessAudit::getCreatedAt)
                .last("LIMIT " + Math.max(1, Math.min(limit, 200))));
    }

    /** 院方回执：本次调阅已归档到病案 */
    public void markArchived(long userId, String hospitalCode, String appKey,
                             LocalDate visitDate, List<Long> recordIds, String ip) {
        List<Long> ids = recordIds == null ? new ArrayList<>() : recordIds;
        recordAudit(userId, hospitalCode, appKey, AccessAudit.ACTION_ARCHIVED,
                visitDate, ids, ip);
    }
}
