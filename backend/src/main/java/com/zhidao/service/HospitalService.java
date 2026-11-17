package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.entity.BookingOrder;
import com.zhidao.entity.Hospital;
import com.zhidao.entity.SysUser;
import com.zhidao.mapper.BookingOrderMapper;
import com.zhidao.mapper.HospitalMapper;
import com.zhidao.mapper.SysUserMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 院区名称查询。
 *
 * <p>单独抽出来是因为它被三个地方要用（预约列表、提醒文案、病历时间轴），
 * 而且都要做同一件事：<b>把 hospital_code 翻成人话</b>。
 * 复制三遍的最大风险不是重复，是某天改文案时只改了两处。
 */
@Service
@RequiredArgsConstructor
public class HospitalService {

    private final HospitalMapper hospitalMapper;
    private final BookingOrderMapper bookingMapper;
    private final SysUserMapper userMapper;

    /** code -> 展示名。一次全查，量小（个位数院区），不用缓存 */
    public Map<String, String> nameMap() {
        return hospitalMapper.selectList(null).stream()
                .filter(h -> h.getHospitalCode() != null && h.getName() != null)
                .collect(Collectors.toMap(Hospital::getHospitalCode, Hospital::getName,
                        (a, b) -> a, HashMap::new));
    }

    public String nameOf(String code) {
        return nameMap().getOrDefault(code, code);
    }

    /**
     * 取用户 id 列表。
     *
     * <p>提醒引擎是<b>全量扫描</b>，需要知道有哪些患者。
     * 为什么不给 {@code sys_user} 加一个 {@code @Scheduled} 专用查询：
     * 扫表逻辑只关心"有档案的患者"，让引擎自己从档案表发起更自然。
     * 这里反过来是先有用户再有档案，所以用这条兜底查询。量级为个位数。
     */
    public List<Long> activeUserIds() {
        return userMapper.selectList(new LambdaQueryWrapper<SysUser>()
                        .eq(SysUser::getEnabled, true))
                .stream().map(SysUser::getId).toList();
    }

    /** 某用户在某院区的预约单，按就诊时间正序 */
    public List<BookingOrder> bookingsOf(long userId) {
        return bookingMapper.selectList(new LambdaQueryWrapper<BookingOrder>()
                .eq(BookingOrder::getUserId, userId)
                .orderByAsc(BookingOrder::getVisitTime));
    }

    /** 距今天最近的一笔未完成预约；没有则 null */
    public BookingOrder nextBooking(long userId) {
        return nextBooking(userId, LocalDate.now());
    }

    /**
     * 距「指定今天」最近的一笔未完成预约。
     *
     * <p><b>为什么把 today 做成参数，而不是在这里直接用 {@code LocalDate.now()}：</b>
     * 提醒引擎按传入的 now 计算"距就诊几小时"，如果这个过滤偷偷用系统时钟，
     * 两条时间轴就会打架。真实踩到的表现是：测试固定 2026-11-14，
     * 而机器已经是 11-17，种子预约 11-15 被当成"一天前"过滤掉，
     * 禁食提醒永远不触发 —— 测试在开发当天是绿的，过几天就红。
     * 时间必须从同一个入口进来。
     */
    public BookingOrder nextBooking(long userId, LocalDate today) {
        return bookingsOf(userId).stream()
                .filter(b -> !BookingOrder.STATUS_CANCELLED.equals(b.getStatus()))
                .filter(b -> !BookingOrder.STATUS_COMPLETED.equals(b.getStatus()))
                .filter(b -> b.getVisitTime() != null
                        && !b.getVisitTime().toLocalDate().isBefore(today.minusDays(1)))
                .findFirst()
                .orElse(null);
    }
}
