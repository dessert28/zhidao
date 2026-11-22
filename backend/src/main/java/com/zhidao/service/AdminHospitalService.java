package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.zhidao.common.BizException;
import com.zhidao.common.PageResult;
import com.zhidao.dto.AdminHospitalRequest;
import com.zhidao.dto.AdminPlaceRequest;
import com.zhidao.entity.Hospital;
import com.zhidao.entity.HospitalPlace;
import com.zhidao.mapper.HospitalMapper;
import com.zhidao.mapper.HospitalPlaceMapper;
import com.zhidao.vo.AdminHospitalView;
import com.zhidao.vo.AdminPlaceView;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.List;
import java.util.Set;

/**
 * 管理端院区与院内地点维护。
 *
 * <p>两条数据规则在这里落地：
 * <ol>
 *   <li><b>院区编码不可改</b>。预约单、病历、导航数据都按
 *       {@code hospitalCode} 引用院区，改编码等于把这些记录静默指向
 *       另一家医院（同 {@code Hospital} 实体注释里的理由）</li>
 *   <li><b>删院区要连带删地点</b>。逻辑删除只把
 *       {@code deleted} 置 1，不做级联；留着的院内地点会变成孤儿数据，
 *       一旦将来有人按地点反查或重新启用编码，就会读到上一家医院的楼层</li>
 * </ol>
 *
 * <p>{@code placeCount} 在列表里逐条 count。数据量是"每家医院几十条"，
 * 一次 group by 换来的复杂度不值得；等真要分页展示几千家院区时再优化，
 * 那时的瓶颈也一定不在这几条 count 上。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AdminHospitalService {

    /**
     * 合法地点类型。
     *
     * <p>这些值与 {@code HospitalNavService} 的就诊阶段顺序绑定：
     * 写错一个类型，那个地点就永远不会出现在导航时间线上 ——
     * 数据看着没问题，患者却少了一步。所以在入口处就挡掉。
     */
    private static final Set<String> PLACE_TYPES = Set.of(
            "REGISTER", "LAB", "CLINIC", "EXAM", "PHARMACY", "CASHIER", "REPORT", "OTHER");

    /** 数据质量只有两档：院方提供 / 演示示意。见 HospitalPlace 类注释 */
    private static final Set<String> DATA_QUALITIES = Set.of("REAL", "SAMPLE");

    private static final long MAX_PAGE_SIZE = 100;

    private final HospitalMapper hospitalMapper;
    private final HospitalPlaceMapper placeMapper;

    /* ============================ 院区 ============================ */

    public PageResult<AdminHospitalView> page(String keyword, long page, long size) {
        long safePage = Math.max(1, page);
        long safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, size));

        LambdaQueryWrapper<Hospital> qw = new LambdaQueryWrapper<>();
        if (StringUtils.hasText(keyword)) {
            String kw = keyword.trim();
            // 括号由 and(...) 提供，否则 OR 会绕过其他过滤条件
            qw.and(w -> w.like(Hospital::getName, kw)
                    .or().like(Hospital::getHospitalCode, kw));
        }
        qw.orderByDesc(Hospital::getId);

        Page<Hospital> result = hospitalMapper.selectPage(new Page<>(safePage, safeSize), qw);
        List<AdminHospitalView> records = result.getRecords().stream()
                .map(h -> new AdminHospitalView(
                        h.getHospitalCode(), h.getName(), h.getLevel(), h.getCity(),
                        h.getAdapterType(), h.getEnabled(),
                        // 逻辑删除由插件自动加到 count 上，所以这里天然只数未删除的
                        placeMapper.selectCount(new LambdaQueryWrapper<HospitalPlace>()
                                .eq(HospitalPlace::getHospitalCode, h.getHospitalCode()))))
                .toList();
        return PageResult.of(records, result.getTotal(), safePage, safeSize);
    }

    @Transactional
    public void create(AdminHospitalRequest req) {
        String code = req.hospitalCode() == null ? "" : req.hospitalCode().trim();
        if (code.isEmpty()) {
            throw new BizException(40001, "院区编码不能为空");
        }
        Long exists = hospitalMapper.selectCount(new LambdaQueryWrapper<Hospital>()
                .eq(Hospital::getHospitalCode, code));
        if (exists != null && exists > 0) {
            throw new BizException(40901, "院区编码已存在");
        }

        Hospital h = new Hospital();
        h.setHospitalCode(code);
        applyEditableFields(h, req);
        try {
            hospitalMapper.insert(h);
        } catch (DuplicateKeyException e) {
            /*
             * 与用户名的情形相同：逻辑删除的行仍占着 uk_hospital_code。
             * 这里给出明确的 409 而不是让唯一索引把异常抛成 500 ——
             * 运维看到"编码被已删除的历史记录占用"就知道该换个编码，
             * 看到"服务暂时不可用"只会来问我们。
             */
            throw new BizException(40901, "院区编码已被已删除的历史记录占用，请换一个编码");
        }
        log.info("管理端新建院区 code={}", code);
    }

    /**
     * 修改院区。
     *
     * <p>{@code hospitalCode} 以路径为准，请求体里的同名字段被忽略 ——
     * 不是"没想到"，而是故意不允许改。
     */
    @Transactional
    public void update(String code, AdminHospitalRequest req) {
        Hospital h = requireHospital(code);
        applyEditableFields(h, req);
        hospitalMapper.updateById(h);
        log.info("管理端修改院区 code={}", code);
    }

    /**
     * 删除院区，并连带逻辑删除其院内地点。
     *
     * <p>顺序是先删地点再删院区：如果先删院区、删地点时抛异常，
     * 就会留下"院区已消失、地点还在"的半成品状态。事务能兜底，
     * 但顺序正确仍然是更便宜的做法。
     */
    @Transactional
    public void delete(String code) {
        Hospital h = requireHospital(code);
        placeMapper.delete(new LambdaQueryWrapper<HospitalPlace>()
                .eq(HospitalPlace::getHospitalCode, code));
        hospitalMapper.deleteById(h.getId());
        log.info("管理端删除院区 code={}（连带删除其院内地点）", code);
    }

    /* ============================ 院内地点 ============================ */

    public List<AdminPlaceView> listPlaces(String code) {
        requireHospital(code);
        return placeMapper.selectList(new LambdaQueryWrapper<HospitalPlace>()
                        .eq(HospitalPlace::getHospitalCode, code)
                        // sortOrder 相同再按 id：没有第二排序键时同序号记录的顺序
                        // 由数据库决定，每次刷新都可能变
                        .orderByAsc(HospitalPlace::getSortOrder)
                        .orderByAsc(HospitalPlace::getId))
                .stream()
                .map(p -> new AdminPlaceView(p.getId(), p.getPlaceType(), p.getDepartment(),
                        p.getName(), p.getBuilding(), p.getFloor(), p.getDirections(),
                        p.getOpenHours(), p.getEstMinutes(), p.getSortOrder(), p.getDataQuality()))
                .toList();
    }

    @Transactional
    public Long addPlace(String code, AdminPlaceRequest req) {
        requireHospital(code);

        String type = req.placeType().trim().toUpperCase();
        if (!PLACE_TYPES.contains(type)) {
            throw new BizException(40001,
                    "地点类型只能是 REGISTER/LAB/CLINIC/EXAM/PHARMACY/CASHIER/REPORT/OTHER");
        }

        // 缺省 SAMPLE 而不是 REAL：没标来源的数据一律按"示意"处理，
        // 宁可界面上多一句提示，也不要把编的楼层说成院方提供的
        String quality = StringUtils.hasText(req.dataQuality())
                ? req.dataQuality().trim().toUpperCase() : "SAMPLE";
        if (!DATA_QUALITIES.contains(quality)) {
            throw new BizException(40001, "数据质量只能是 REAL 或 SAMPLE");
        }

        HospitalPlace p = new HospitalPlace();
        p.setHospitalCode(code);
        p.setPlaceType(type);
        p.setDepartment(req.department());
        p.setName(req.name().trim());
        p.setBuilding(req.building());
        p.setFloor(req.floor());
        p.setDirections(req.directions());
        p.setOpenHours(req.openHours());
        p.setEstMinutes(req.estMinutes());
        // 不传序号时给 100：与表默认值一致，保证新地点排在科室/检查之后，
        // 不会因为顺序值 0 突然插到"挂号"前面
        p.setSortOrder(req.sortOrder() == null ? 100 : req.sortOrder());
        p.setDataQuality(quality);
        placeMapper.insert(p);

        log.info("管理端新增院内地点 id={} hospital={} type={}", p.getId(), code, type);
        return p.getId();
    }

    @Transactional
    public void deletePlace(long id) {
        HospitalPlace p = placeMapper.selectById(id);
        if (p == null) {
            throw new BizException(40401, "院内地点不存在");
        }
        placeMapper.deleteById(id);
        log.info("管理端删除院内地点 id={} hospital={}", id, p.getHospitalCode());
    }

    /* ============================ 内部 ============================ */

    private Hospital requireHospital(String code) {
        Hospital h = hospitalMapper.selectOne(new LambdaQueryWrapper<Hospital>()
                .eq(Hospital::getHospitalCode, code));
        if (h == null) {
            throw new BizException(40401, "院区不存在");
        }
        return h;
    }

    /**
     * 把可编辑字段写入实体。null 表示保持原值。
     *
     * <p>{@code adapterType} 与 {@code enabled} 在新建设置默认值：
     * 省赛只有 MOCK 适配器，默认不启用一个院区比默认启用更危险
     * （患者能选到一家还没有号源的医院）。
     */
    private void applyEditableFields(Hospital h, AdminHospitalRequest req) {
        h.setName(req.name().trim());
        h.setLevel(req.level());
        h.setCity(req.city());
        if (StringUtils.hasText(req.adapterType())) {
            h.setAdapterType(req.adapterType().trim().toUpperCase());
        } else if (h.getAdapterType() == null) {
            h.setAdapterType("MOCK");
        }
        if (req.enabled() != null) {
            h.setEnabled(req.enabled());
        } else if (h.getEnabled() == null) {
            h.setEnabled(true);
        }
    }
}
