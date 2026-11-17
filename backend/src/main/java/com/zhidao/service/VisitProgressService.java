package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.common.BizException;
import com.zhidao.entity.VisitStepProgress;
import com.zhidao.mapper.VisitStepProgressMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 就诊流程的手动进度。
 *
 * <p><b>它解决的是"系统以为的"和"实际发生的"不一致</b>：
 * 抽血排长队、医生临时取消某项检查、患者中途去缴费 ——
 * 这些都会让按时间推算的默认进度跑偏。而患者自己最清楚走到哪了。
 *
 * <p>设计上刻意保持极简：只有 DONE 和 SKIPPED 两种标记，
 * 加上"删除标记 = 回到默认"。没有审核、没有冲突合并、
 * 没有"部分完成"这种中间态 —— 就医过程中没人愿意研究一套状态机。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class VisitProgressService {

    /** 允许的 state 取值。收在服务层，Controller 不自己判断合法性 */
    private static final Set<String> VALID_STATES =
            Set.of(VisitStepProgress.STATE_DONE, VisitStepProgress.STATE_SKIPPED);

    /** nav_key 长度上限，与 schema 的 VARCHAR(96) 对齐 */
    private static final int MAX_KEY_LEN = 96;

    private final VisitStepProgressMapper mapper;

    /**
     * 读一张预约单的全部手动进度。
     *
     * @return navKey → state，界面据此覆盖时间推算的结果
     */
    public Map<String, String> progressOf(long userId, long bookingId) {
        List<VisitStepProgress> rows = mapper.selectList(new LambdaQueryWrapper<VisitStepProgress>()
                .eq(VisitStepProgress::getUserId, userId)
                .eq(VisitStepProgress::getBookingId, bookingId)
                .orderByAsc(VisitStepProgress::getDoneAt));

        Map<String, String> out = new LinkedHashMap<>();
        for (VisitStepProgress r : rows) {
            out.put(r.getNavKey(), r.getState());
        }
        return out;
    }

    /**
     * 标记某一步。
     *
     * <p><b>幂等</b>：同一单同一步重复标记只更新时间，不新增行。
     * 患者在等待时反复点"完成"很常见，每次插入一条会让进度表变成噪音。
     *
     * @param state DONE 或 SKIPPED；传空串表示清除标记（回到默认）
     */
    @Transactional
    public Map<String, String> mark(long userId, long bookingId, String navKey, String state) {
        if (navKey == null || navKey.isBlank()) {
            throw new BizException(40000, "缺少步骤标识");
        }
        if (navKey.length() > MAX_KEY_LEN) {
            /*
             * 这里选择拒绝而不是截断：截断后的 key 会和别的步骤撞上，
             * 表现为"标了 A 步却显示 B 步完成"—— 比报错难查得多。
             */
            throw new BizException(40000, "步骤标识过长");
        }

        // 空串 = 清除这一步的标记，回到按时间推算的默认值
        if (state == null || state.isBlank()) {
            mapper.delete(new LambdaQueryWrapper<VisitStepProgress>()
                    .eq(VisitStepProgress::getUserId, userId)
                    .eq(VisitStepProgress::getBookingId, bookingId)
                    .eq(VisitStepProgress::getNavKey, navKey));
            return progressOf(userId, bookingId);
        }

        String normalized = state.trim().toUpperCase();
        if (!VALID_STATES.contains(normalized)) {
            throw new BizException(40000, "状态只能是 DONE 或 SKIPPED");
        }

        VisitStepProgress existing = mapper.selectOne(new LambdaQueryWrapper<VisitStepProgress>()
                .eq(VisitStepProgress::getUserId, userId)
                .eq(VisitStepProgress::getBookingId, bookingId)
                .eq(VisitStepProgress::getNavKey, navKey)
                .last("limit 1"));

        if (existing == null) {
            VisitStepProgress row = new VisitStepProgress();
            row.setUserId(userId);
            row.setBookingId(bookingId);
            row.setNavKey(navKey);
            row.setState(normalized);
            row.setDoneAt(LocalDateTime.now());
            mapper.insert(row);
        } else {
            existing.setState(normalized);
            existing.setDoneAt(LocalDateTime.now());
            mapper.updateById(existing);
        }

        log.info("流程进度标记 booking={} key={} state={}", bookingId, navKey, normalized);
        return progressOf(userId, bookingId);
    }
}
