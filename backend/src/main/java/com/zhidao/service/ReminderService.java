package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.common.BizException;
import com.zhidao.entity.ReminderTask;
import com.zhidao.mapper.ReminderTaskMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;

/**
 * 提醒任务的查询与状态流转。
 *
 * <p>真正的"引擎"在 {@link ReminderEngine}（定时扫表生成任务），
 * 这里只负责查询和用户动作（已读 / 完成 / 忽略）。
 *
 * <p>{@code reason} 字段是这张表的灵魂：每条提醒都要能回答
 * "为什么提醒你"。没有 reason 的提醒和手机日历的闹钟没区别。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ReminderService {

    private final ReminderTaskMapper reminderMapper;

    /** 待处理的提醒，按到期时间正序 —— 最近要做的排最前 */
    public List<ReminderTask> pending(long userId) {
        return reminderMapper.selectList(new LambdaQueryWrapper<ReminderTask>()
                .eq(ReminderTask::getUserId, userId)
                .in(ReminderTask::getStatus, List.of(
                        ReminderTask.STATUS_PENDING, ReminderTask.STATUS_SENT))
                .orderByAsc(ReminderTask::getDueAt));
    }

    /** 全部提醒（含已完成/已忽略），给"提醒历史"用 */
    public List<ReminderTask> all(long userId) {
        return reminderMapper.selectList(new LambdaQueryWrapper<ReminderTask>()
                .eq(ReminderTask::getUserId, userId)
                .orderByDesc(ReminderTask::getDueAt));
    }

    @Transactional
    public ReminderTask mark(long userId, long id, String status) {
        if (!List.of(ReminderTask.STATUS_DONE, ReminderTask.STATUS_SKIPPED).contains(status)) {
            throw new BizException("只能标记为 DONE 或 SKIPPED");
        }
        ReminderTask t = reminderMapper.selectById(id);
        if (t == null || !t.getUserId().equals(userId)) {
            throw new BizException(40400, "提醒不存在");
        }
        if (ReminderTask.STATUS_PENDING.equals(t.getStatus())) {
            // 从 PENDING 直接跳到 DONE 是合法的：用户可能在通知发出前就已经做了
            t.setStatus(status);
        } else if (ReminderTask.STATUS_SENT.equals(t.getStatus())) {
            t.setStatus(status);
        } else {
            throw new BizException(40901, "这条提醒已经处理过了");
        }
        reminderMapper.updateById(t);
        return t;
    }

    /**
     * 到期未发的提醒，引擎扫描用。
     *
     * <p>{@code lookbackHours} 的下界不是多余的限制：
     * 没有它，一次重启会把三个月前的任务全部当成"该发了"补发一遍，
     * 用户会一夜之间收到二十条过期提醒。
     */
    public List<ReminderTask> dueNow(LocalDateTime now, int lookbackHours) {
        return reminderMapper.selectList(new LambdaQueryWrapper<ReminderTask>()
                .eq(ReminderTask::getStatus, ReminderTask.STATUS_PENDING)
                .le(ReminderTask::getDueAt, now)
                .ge(ReminderTask::getDueAt, now.minusHours(lookbackHours))
                .orderByAsc(ReminderTask::getDueAt));
    }
}
