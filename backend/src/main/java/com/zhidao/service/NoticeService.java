package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.zhidao.common.BizException;
import com.zhidao.common.PageResult;
import com.zhidao.dto.NoticeRequest;
import com.zhidao.entity.SysNotice;
import com.zhidao.mapper.SysNoticeMapper;
import com.zhidao.vo.NoticeView;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Set;

/**
 * 公告服务，管理端与患者端共用。
 *
 * <p><b>患者端过滤条件只有一条，但三个条件都不能少</b>：
 * {@code status = PUBLISHED}、{@code publishedAt <= now}、{@code deleted = 0}（插件负责）。
 * 少了时间判断，提前写好的公告会立刻出现在患者首页；
 * 少了状态判断，草稿会被当成正式通知 —— 草稿里写错一个字，
 * 就是全院患者都收到了一条错的停诊通知。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class NoticeService {

    private static final Set<String> LEVELS = Set.of("INFO", "WARN", "URGENT");

    private static final long MAX_PAGE_SIZE = 100;

    private final SysNoticeMapper noticeMapper;

    /* ============================ 管理端 ============================ */

    /**
     * 管理端列表：置顶优先，其次按发布时间倒序。
     *
     * <p>发布时间的 null 排序交给数据库处理：未发布的草稿没有发布时间，
     * 它们排在哪里都不影响阅读，但置顶与已发布之间的顺序必须稳定。
     * 最后补 id 倒序做 tie-breaker，避免同一天发布的两条公告
     * 在每次刷新时互换位置。
     */
    public PageResult<NoticeView> page(long page, long size) {
        long safePage = Math.max(1, page);
        long safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, size));

        Page<SysNotice> result = noticeMapper.selectPage(new Page<>(safePage, safeSize),
                new LambdaQueryWrapper<SysNotice>()
                        .orderByDesc(SysNotice::getPinned)
                        .orderByDesc(SysNotice::getPublishedAt)
                        .orderByDesc(SysNotice::getId));

        List<NoticeView> records = result.getRecords().stream()
                .map(this::toView)
                .toList();
        return PageResult.of(records, result.getTotal(), safePage, safeSize);
    }

    @Transactional
    public Long create(NoticeRequest req) {
        SysNotice n = new SysNotice();
        n.setTitle(req.title().trim());
        n.setContent(req.content().trim());
        n.setLevel(normalizeLevel(req.level()));
        n.setPinned(Boolean.TRUE.equals(req.pinned()));
        n.setStatus(normalizeStatus(req.status()));
        // 发布即生效：没有单独的"定时发布"入口时，让发布操作自己补时间，
        // 否则会出现 status=PUBLISHED 但 publishedAt 为空的行 ——
        // 患者端按时间过滤时永远看不到它
        if (SysNotice.STATUS_PUBLISHED.equals(n.getStatus())) {
            n.setPublishedAt(LocalDateTime.now());
        }
        noticeMapper.insert(n);
        log.info("管理端新建公告 id={} status={}", n.getId(), n.getStatus());
        return n.getId();
    }

    @Transactional
    public void update(long id, NoticeRequest req) {
        SysNotice n = requireNotice(id);
        n.setTitle(req.title().trim());
        n.setContent(req.content().trim());
        n.setLevel(normalizeLevel(req.level()));
        n.setPinned(Boolean.TRUE.equals(req.pinned()));

        String newStatus = normalizeStatus(req.status());
        // 已经是 PUBLISHED 的公告再次编辑，不刷新发布时间 ——
        // 否则每次改错别字都会把它顶到列表最前面
        if (SysNotice.STATUS_PUBLISHED.equals(newStatus) && n.getPublishedAt() == null) {
            n.setPublishedAt(LocalDateTime.now());
        }
        n.setStatus(newStatus);
        noticeMapper.updateById(n);
        log.info("管理端修改公告 id={} status={}", id, newStatus);
    }

    @Transactional
    public void delete(long id) {
        requireNotice(id);
        noticeMapper.deleteById(id);
        log.info("管理端删除公告 id={}", id);
    }

    /* ============================ 患者端 ============================ */

    /**
     * 患者端公告列表。
     *
     * <p>{@code limit} 被夹到 1-50：患者首页只放得下两三条，
     * 而接口是公开给所有登录用户的，不设上限等于提供一个
     * "一次拉走全部公告正文"的入口。
     */
    public List<NoticeView> listPublished(int limit) {
        int safeLimit = Math.min(50, Math.max(1, limit));
        return noticeMapper.selectList(new LambdaQueryWrapper<SysNotice>()
                        .eq(SysNotice::getStatus, SysNotice.STATUS_PUBLISHED)
                        .le(SysNotice::getPublishedAt, LocalDateTime.now())
                        .orderByDesc(SysNotice::getPinned)
                        .orderByDesc(SysNotice::getPublishedAt)
                        .orderByDesc(SysNotice::getId)
                        .last("LIMIT " + safeLimit))
                .stream()
                .map(this::toView)
                .toList();
    }

    /* ============================ 内部 ============================ */

    private SysNotice requireNotice(long id) {
        SysNotice n = noticeMapper.selectById(id);
        if (n == null) {
            throw new BizException(40401, "公告不存在");
        }
        return n;
    }

    private String normalizeLevel(String level) {
        String lv = StringUtils.hasText(level) ? level.trim().toUpperCase() : "INFO";
        if (!LEVELS.contains(lv)) {
            throw new BizException(40001, "公告级别只能是 INFO / WARN / URGENT");
        }
        return lv;
    }

    private String normalizeStatus(String status) {
        String st = StringUtils.hasText(status) ? status.trim().toUpperCase() : SysNotice.STATUS_DRAFT;
        if (!SysNotice.STATUS_DRAFT.equals(st) && !SysNotice.STATUS_PUBLISHED.equals(st)) {
            throw new BizException(40001, "公告状态只能是 DRAFT 或 PUBLISHED");
        }
        return st;
    }

    private NoticeView toView(SysNotice n) {
        return new NoticeView(n.getId(), n.getTitle(), n.getContent(), n.getLevel(),
                n.getPinned(), n.getStatus(), n.getPublishedAt(), n.getCreatedAt());
    }
}
