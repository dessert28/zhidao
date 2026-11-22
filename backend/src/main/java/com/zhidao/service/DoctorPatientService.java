package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.zhidao.common.BizException;
import com.zhidao.common.PageResult;
import com.zhidao.entity.BookingOrder;
import com.zhidao.entity.MedicalRecord;
import com.zhidao.entity.PatientProfile;
import com.zhidao.entity.SysUser;
import com.zhidao.mapper.BookingOrderMapper;
import com.zhidao.mapper.MedicalRecordMapper;
import com.zhidao.mapper.SysUserMapper;
import com.zhidao.vo.DoctorPatientView;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.time.LocalDate;
import java.util.List;

/**
 * 医生工作台的患者列表。
 *
 * <p>这与 {@code /api/doctor/brief/**} 是<b>两条不同的路</b>：
 * <ul>
 *   <li>brief 是一次性 token 的免登录链接，给"医生在自己电脑上快速看一眼
 *       预问诊摘要"用，范围极小、会过期</li>
 *   <li>这里需要医生账号（JWT + ROLE_DOCTOR），能看名下患者的档案、
 *       过敏史、用药与最近就诊记录</li>
 * </ul>
 * 两套契约不能合并：brief 一旦要求登录，微信里点链接的医生就打不开；
 * 这里一旦允许免登录，任何拿到链接的人都能翻患者档案。
 *
 * <p><b>为什么按"全部 PATIENT"而不是按"我的患者"</b>：
 * 课设阶段没有建立医生-患者归属关系（没有科室排班、没有接诊表），
 * 硬造一个归属字段会让数据变成假的。当前口径是"医生可以检索全院患者"，
 * 并在类注释里写明这是课设边界；真实上线必须补接诊关系，
 * 否则违反最小必要原则。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class DoctorPatientService {

    private static final String PATIENT = "PATIENT";
    private static final long MAX_PAGE_SIZE = 100;
    private static final int RECENT_LIMIT = 10;

    private final SysUserMapper userMapper;
    private final MedicalRecordMapper recordMapper;
    private final BookingOrderMapper bookingMapper;

    /** 复用患者侧服务做档案 JSON 解析与年龄推算，避免两套口径各算一遍 */
    private final PatientService patientService;

    public PageResult<DoctorPatientView> page(String keyword, long page, long size) {
        long safePage = Math.max(1, page);
        long safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, size));

        LambdaQueryWrapper<SysUser> qw = new LambdaQueryWrapper<SysUser>()
                .select(SysUser::getId, SysUser::getUsername, SysUser::getDisplayName)
                .eq(SysUser::getRole, PATIENT);

        if (StringUtils.hasText(keyword)) {
            String kw = keyword.trim();
            qw.and(w -> w.like(SysUser::getDisplayName, kw)
                    .or().like(SysUser::getUsername, kw));
        }
        qw.orderByDesc(SysUser::getId);

        Page<SysUser> result = userMapper.selectPage(new Page<>(safePage, safeSize), qw);
        List<DoctorPatientView> records = result.getRecords().stream()
                // 列表不带病历与预约：那是详情页的事，一页 20 个患者
                // 各带 10 条记录会让一次翻页变成 200 条数据
                .map(u -> build(u, null, null))
                .toList();
        return PageResult.of(records, result.getTotal(), safePage, safeSize);
    }

    public DoctorPatientView detail(long userId) {
        SysUser u = userMapper.selectById(userId);
        // 不是 PATIENT 也按 404 处理，不返回 403：
        // 403 会告诉调用方"这个 id 存在，只是角色不对"，
        // 医生端不该有枚举管理员账号的入口
        if (u == null || !PATIENT.equals(u.getRole())) {
            throw new BizException(40401, "患者不存在");
        }

        List<DoctorPatientView.RecordItem> records = recordMapper.selectList(
                        new LambdaQueryWrapper<MedicalRecord>()
                                .eq(MedicalRecord::getUserId, userId)
                                .orderByDesc(MedicalRecord::getVisitDate)
                                .orderByDesc(MedicalRecord::getId)
                                .last("LIMIT " + RECENT_LIMIT))
                .stream()
                .map(r -> new DoctorPatientView.RecordItem(r.getId(), r.getVisitDate(),
                        r.getHospitalCode(), r.getDepartment(), r.getDiagnosisBrief()))
                .toList();

        List<DoctorPatientView.BookingItem> bookings = bookingMapper.selectList(
                        new LambdaQueryWrapper<BookingOrder>()
                                .eq(BookingOrder::getUserId, userId)
                                .orderByDesc(BookingOrder::getVisitTime)
                                .orderByDesc(BookingOrder::getId)
                                .last("LIMIT " + RECENT_LIMIT))
                .stream()
                .map(b -> new DoctorPatientView.BookingItem(b.getId(), b.getVisitTime(),
                        b.getDepartment(), b.getStatus()))
                .toList();

        return build(u, records, bookings);
    }

    /* ============================ 内部 ============================ */

    /**
     * 组装视图。
     *
     * <p>逐患者查询档案与计数（一页 20 条 = 60 次小查询）。
     * 课设数据量下这是最直白的写法；真要优化，正确方向是把
     * 计数改成一次 {@code GROUP BY user_id}，而不是给这三次查询加缓存 ——
     * 缓存只会把"数字不实时"变成一个新的问题。
     */
    private DoctorPatientView build(SysUser u, List<DoctorPatientView.RecordItem> records,
                                    List<DoctorPatientView.BookingItem> bookings) {
        long userId = u.getId();
        PatientProfile p = patientService.getProfile(userId);

        Long recordCount = recordMapper.selectCount(new LambdaQueryWrapper<MedicalRecord>()
                .eq(MedicalRecord::getUserId, userId));
        Long bookingCount = bookingMapper.selectCount(new LambdaQueryWrapper<BookingOrder>()
                .eq(BookingOrder::getUserId, userId));

        MedicalRecord last = recordMapper.selectOne(new LambdaQueryWrapper<MedicalRecord>()
                .eq(MedicalRecord::getUserId, userId)
                .orderByDesc(MedicalRecord::getVisitDate)
                .orderByDesc(MedicalRecord::getId)
                .last("LIMIT 1"));
        LocalDate lastVisitDate = last == null ? null : last.getVisitDate();

        return new DoctorPatientView(
                userId,
                u.getDisplayName(),
                p.getGender(),
                patientService.ageOf(p),
                // 解析失败返回空数组而不是抛异常：某条脏数据
                // 不该让整个患者列表 500（同 PatientService.parseJsonList）
                patientService.parseJsonList(p.getAllergyJson()),
                patientService.parseJsonList(p.getChronicJson()),
                patientService.parseJsonList(p.getMedicationJson()),
                recordCount == null ? 0 : recordCount,
                bookingCount == null ? 0 : bookingCount,
                lastVisitDate,
                records,
                bookings);
    }
}
