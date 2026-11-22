package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.zhidao.common.BizException;
import com.zhidao.common.PageResult;
import com.zhidao.dto.AdminUserCreateRequest;
import com.zhidao.dto.AdminUserUpdateRequest;
import com.zhidao.entity.SysUser;
import com.zhidao.mapper.SysUserMapper;
import com.zhidao.vo.AdminUserView;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.List;
import java.util.Set;

/**
 * 管理端用户管理。
 *
 * <p>这一层最重要的不是 CRUD，而是三条<b>防止把自己锁在门外</b>的规则：
 * <ol>
 *   <li>不能改自己的角色或启用状态 —— 管理员误点一下就把自己降成患者，
 *       而且没有第二个入口能改回来</li>
 *   <li>不能禁用/降级<b>最后一个</b>启用的管理员 —— 系统里一个管理员都不剩时，
 *       所有 {@code /api/admin/**} 永久 403，只能改数据库</li>
 *   <li>不能删除自己 / 不能删除最后一个管理员 —— 同上，逻辑删除之后再无入口</li>
 * </ol>
 *
 * <p>这三条放在 Service 而不是 Controller：将来如果有批量导入或运维脚本
 * 复用这套逻辑，保护必须跟着走，不能只挂在 HTTP 层。
 *
 * <p><b>关于密码</b>：本类只接收明文并立即交给 {@link PasswordEncoder}。
 * 明文不写日志、不落库、不回显 —— 与 {@code AuthService} 的约定一致。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AdminUserService {

    /** 允许的角色。用 Set 而不是枚举：角色是数据，不是代码分支 */
    private static final Set<String> ROLES = Set.of("PATIENT", "DOCTOR", "ADMIN");

    private static final String ADMIN = "ADMIN";

    /** 单页上限。防止前端传 size=100000 把整张表拉进内存 */
    private static final long MAX_PAGE_SIZE = 100;

    private final SysUserMapper userMapper;
    private final PasswordEncoder passwordEncoder;

    /**
     * 分页查询。
     *
     * <p>用 {@code select(...)} 显式挑列，而不是查完实体再转 view：
     * 前者从 SQL 层就不取 {@code password_hash}，后者只是"没把它放进响应"。
     * 少一次把哈希读进 JVM 内存，就少一次它出现在异常日志/堆转储里的机会。
     */
    public PageResult<AdminUserView> page(String keyword, String role, long page, long size) {
        long safePage = Math.max(1, page);
        long safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, size));

        LambdaQueryWrapper<SysUser> qw = new LambdaQueryWrapper<SysUser>()
                .select(SysUser::getId, SysUser::getUsername, SysUser::getDisplayName,
                        SysUser::getRole, SysUser::getEnabled, SysUser::getCreatedAt);

        if (StringUtils.hasText(keyword)) {
            String kw = keyword.trim();
            // 括号必须由 and(...) 生成：不加括号会变成
            // "role = ? AND username LIKE ? OR display_name LIKE ?"，
            // OR 会把角色过滤条件绕过去
            qw.and(w -> w.like(SysUser::getUsername, kw)
                    .or().like(SysUser::getDisplayName, kw));
        }
        if (StringUtils.hasText(role)) {
            qw.eq(SysUser::getRole, role.trim().toUpperCase());
        }
        qw.orderByDesc(SysUser::getId);

        Page<SysUser> result = userMapper.selectPage(new Page<>(safePage, safeSize), qw);
        List<AdminUserView> records = result.getRecords().stream()
                .map(u -> new AdminUserView(u.getId(), u.getUsername(), u.getDisplayName(),
                        u.getRole(), u.getEnabled(), u.getCreatedAt()))
                .toList();
        return PageResult.of(records, result.getTotal(), safePage, safeSize);
    }

    /**
     * 新建用户。
     *
     * <p>用户名重复返回 40901（与注册接口同一个业务码），
     * 前端才能复用"换一个用户名"的提示逻辑。
     */
    @Transactional
    public Long create(AdminUserCreateRequest req) {
        String username = req.username().trim();
        String role = normalizeRole(req.role());

        Long exists = userMapper.selectCount(new LambdaQueryWrapper<SysUser>()
                .eq(SysUser::getUsername, username));
        if (exists != null && exists > 0) {
            throw new BizException(40901, "用户名已存在，请换一个");
        }

        SysUser user = new SysUser();
        user.setUsername(username);
        user.setDisplayName(StringUtils.hasText(req.displayName()) ? req.displayName().trim() : null);
        user.setPasswordHash(passwordEncoder.encode(req.password()));
        user.setRole(role);
        user.setEnabled(true);
        try {
            userMapper.insert(user);
        } catch (DuplicateKeyException e) {
            /*
             * 上面的 selectCount 只数得到未删除的行（逻辑删除由插件过滤），
             * 但唯一索引不管 deleted —— 删掉的账号仍然占着这个用户名。
             * 不接住这个异常，管理员"删错了再加回来"就会看到 500，
             * 而 500 的提示里没有任何可操作信息。
             */
            throw new BizException(40901, "用户名已被已删除的账号占用，请换一个用户名");
        }

        // 只记 id 与角色，不记用户名 —— 用户名在生产环境常是手机号
        log.info("管理端新建用户 userId={} role={}", user.getId(), role);
        return user.getId();
    }

    /**
     * 局部修改。
     *
     * <p>null 表示"这次不改这一项"，不是"清空"。因此三个 if 而不是逐个 set。
     */
    @Transactional
    public void update(long operatorId, long userId, AdminUserUpdateRequest req) {
        SysUser target = userMapper.selectById(userId);
        if (target == null) {
            throw new BizException(40401, "用户不存在");
        }

        boolean self = operatorId == userId;
        if (self && (req.role() != null || req.enabled() != null)) {
            /*
             * 允许改自己的展示名，但不允许动角色与启用状态。
             * 如果这里放行，一次误操作就能把系统里唯一的管理员降级，
             * 而修复它需要直接连数据库 —— 这是不可接受的运维成本。
             */
            throw new BizException(40301, "不能修改自己的角色或状态");
        }

        if (req.role() != null) {
            String role = normalizeRole(req.role());
            if (!role.equals(target.getRole()) && isEnabledAdmin(target)) {
                ensureNotLastAdmin(userId, "不能降级最后一个启用的管理员");
            }
            target.setRole(role);
        }

        if (req.enabled() != null) {
            if (!req.enabled() && isEnabledAdmin(target)) {
                ensureNotLastAdmin(userId, "不能禁用最后一个启用的管理员");
            }
            target.setEnabled(req.enabled());
        }

        if (req.displayName() != null) {
            target.setDisplayName(req.displayName().trim());
        }

        userMapper.updateById(target);
        log.info("管理端修改用户 userId={} by={}", userId, operatorId);
    }

    /**
     * 逻辑删除。
     *
     * <p>删除与禁用的区别在审计上：删除后查不到这个人，
     * 但他的病历/预约仍然按 user_id 挂在库里（不建外键，也不级联删）。
     * 这正是需要的 —— 删账号不等于删医疗记录。
     */
    @Transactional
    public void delete(long operatorId, long userId) {
        if (operatorId == userId) {
            throw new BizException(40301, "不能删除自己的账号");
        }
        SysUser target = userMapper.selectById(userId);
        if (target == null) {
            throw new BizException(40401, "用户不存在");
        }
        if (isEnabledAdmin(target)) {
            ensureNotLastAdmin(userId, "不能删除最后一个启用的管理员");
        }
        userMapper.deleteById(userId);
        log.info("管理端删除用户 userId={} by={}", userId, operatorId);
    }

    /* ============================ 内部 ============================ */

    private String normalizeRole(String role) {
        String r = role == null ? "" : role.trim().toUpperCase();
        if (!ROLES.contains(r)) {
            throw new BizException(40001, "角色只能是 PATIENT / DOCTOR / ADMIN");
        }
        return r;
    }

    private boolean isEnabledAdmin(SysUser user) {
        return ADMIN.equals(user.getRole()) && Boolean.TRUE.equals(user.getEnabled());
    }

    /**
     * 确认除 {@code excludeId} 之外还有启用的管理员。
     *
     * <p>为什么"排除自己再数"而不是"数完判断 >1"：
     * 后者要求调用方每次都先确认目标确实是启用的管理员，
     * 任何一处漏判就会在非管理员身上误报 40902。
     * 这里把判断收口成一个方法，调用方只需说明"我要动这个人"。
     */
    private void ensureNotLastAdmin(long excludeId, String message) {
        Long others = userMapper.selectCount(new LambdaQueryWrapper<SysUser>()
                .eq(SysUser::getRole, ADMIN)
                .eq(SysUser::getEnabled, true)
                .ne(SysUser::getId, excludeId));
        if (others == null || others == 0) {
            throw new BizException(40902, message);
        }
    }
}
