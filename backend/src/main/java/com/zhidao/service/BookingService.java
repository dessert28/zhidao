package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.adapter.HospitalAdapter;
import com.zhidao.adapter.HospitalAdapterRegistry;
import com.zhidao.common.BizException;
import com.zhidao.dto.BookingRequest;
import com.zhidao.entity.BookingOrder;
import com.zhidao.mapper.BookingOrderMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.stream.Collectors;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 预约业务。
 *
 * <p>这个类最值得看的是<b>状态迁移的校验位置</b>：
 * 规则写在 Service 里而不是实体里，因为"能不能从 CREATED 变成 CANCELLED"
 * 是业务判断，不是数据的属性。把状态机塞进实体，等于让每个用到实体的地方
 * 都继承一套它可能不该遵守的规则。
 *
 * <p>另一件事：<b>下单失败不能悄悄吞掉</b>。
 * 院方返回"该时段已满"和"接口超时"是完全不同的两件事 ——
 * 前者让用户换个时间，后者应该重试。所以 {@link HospitalAdapter.BookingResult}
 * 带回了 message，而不是一个 boolean。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class BookingService {

    /** 合法迁移：源状态 -> 允许的目标状态集合 */
    private static final Map<String, Set<String>> TRANSITIONS = Map.of(
            BookingOrder.STATUS_CREATED, Set.of(BookingOrder.STATUS_CONFIRMED, BookingOrder.STATUS_CANCELLED),
            BookingOrder.STATUS_CONFIRMED, Set.of(BookingOrder.STATUS_COMPLETED, BookingOrder.STATUS_CANCELLED),
            BookingOrder.STATUS_COMPLETED, Set.of(),
            BookingOrder.STATUS_CANCELLED, Set.of()
    );

    private final BookingOrderMapper bookingMapper;
    private final HospitalAdapterRegistry adapters;

    /*
     * ============================ 号源并发串行化 ============================
     *
     * 【要解决什么】
     * create() 原本是"先问院方再落库"：两个人同时点同一个时段，
     * 都通过 remaining 检查、都拿到院方单号、都落库 —— 该时段卖出 4 个号，
     * 而容量只有 3。超出容量的那一位是患者到了医院才发现没号的来源。
     *
     * 【方案：应用层按"院区 + 科室 + 时段"分段加锁】
     * 粒度取这三者的组合，而不是一把全局锁：
     *   · 全局锁实现两行，但会把整个挂号入口串成单通道 ——
     *     一个皮肤科患者下单，阻塞一条街外的心内科患者，旺季直接排队超时
     *   · 按记录加锁（user / order）粒度太细，挡不住"不同人抢同一个号"
     * 同一时段的冲突才是真正需要互斥的，容量是按时段算的，
     * 锁的粒度就该等于容量的粒度。
     *
     * 【为什么是进程内锁而不是分布式锁】
     * 当前部署形态是单实例（docs/10 D6：不引 Redis）。ReentrantLock 在
     * 单实例里就是完备的。**但要诚实说明它的边界**：多实例部署时
     * 各 JVM 各有一张锁表，彼此看不见，这一层保护会失效 ——
     * 那时必须换 Redis / 数据库行锁（docs/08 §5 已列为国赛项）。
     * 这也正是下面"锁内重查号源"依然必要的原因：它让正确性不完全依赖锁。
     */
    private final ConcurrentHashMap<String, ReentrantLock> slotLocks = new ConcurrentHashMap<>();

    /**
     * 等锁的上限，单位毫秒。
     *
     * <p>3 秒的来历：一次下单要串行经过"查号源 + 调院方 book + 落库"，
     * Mock 下是毫秒级，真实院方接口按 1 秒量级预留。3 秒足够让
     * 同时点击的第二、第三个人依次通过（每人只占几百毫秒），
     * 又不至于让用户在界面上干等。
     *
     * <p>超过这个值说明该时段确实被挤爆了，此时**快速失败并告知重试**
     * 比无限等待好：让用户盯着转圈 30 秒最后超时，比直接说
     * "稍后重试"糟糕得多。
     */
    private static final long LOCK_WAIT_MILLIS = 3000L;

    /**
     * 锁 key 的构造。
     *
     * <p><b>为什么是这三段拼起来</b>：容量的定义本来就是
     * "某院区某科室某时段放几个号"（见 {@link HospitalAdapter.Slot#remaining}），
     * 锁的粒度必须与容量的粒度一致 —— 宽了会误伤其他时段的正常下单，
     * 窄了（比如漏掉院区）会让两家院区同一钟点被互相阻塞。
     *
     * <p><b>为什么用 \u0000 分隔而不是 "-" 或 "|"</b>：
     * 院区编码、科室名都是外部输入，科室名本身还可能含 "-"（"口腔-正畸"）。
     * 用可打印字符拼接会出现 key 碰撞：("A-B","C") 与 ("A","B-C") 拼出同一个字符串，
     * 于是两个毫不相干的时段争同一把锁 —— 表现为偶发的"线上有人下单，我这边被拒"，
     * 这种 bug 靠复现几乎查不出来。
     * \u0000（NUL）不可能出现在合法的 HTTP 参数里，用它做分隔符能保证拼接无歧义。
     */
    private String lockKey(String hospitalCode, String department, LocalDateTime visitTime) {
        return hospitalCode + '\u0000' + department + '\u0000' + visitTime;
    }

    /** 查号源：直接问院方适配器，不落库 —— 号源是别人的实时数据 */
    /**
     * 查询号源，并扣减**已被本地预约占用**的数量。
     *
     * <p>为什么要在这里扣：适配器（{@link HospitalAdapter}）代表的是**院方**，
     * 它能说的只是"我们放出了几个号"。而我们本地已经下过的单，
     * 院方适配器并不知道 —— Mock 实现甚至把 remaining 写死成 1。
     *
     * <p>实测缺陷（2026-11-15）：同一时段下单成功后，
     * 再查号源仍然显示 remaining=1，看起来"无限可约"。
     * 虽然重复下单会被 409 拦住，但**展示给用户的数字是错的** ——
     * 患者会以为还有号，点进去才发现被拒。这比没有号更让人困惑。
     *
     * <p>扣减逻辑放在 Service 而不是适配器：
     * 适配器是对院方协议的抽象，不该知道我们的订单表。
     * 一旦把订单查询塞进适配器，换真实院方对接时就要重写一遍。
     *
     * <p>只统计**未取消**的单：CANCELLED 之后号应该回到池子里。
     */
    public List<HospitalAdapter.Slot> querySlots(String hospitalCode, String department, LocalDate date) {
        List<HospitalAdapter.Slot> raw = adapters.of(hospitalCode).querySlots(department, date);
        if (raw.isEmpty()) return raw;

        /*
         * 一次查出这一天该科室所有未取消的订单，在内存里按时间做减。
         * 不逐条 SQL 查：号源通常十几个，逐条查是 N+1。
         */
        LocalDateTime dayStart = date.atStartOfDay();
        LocalDateTime dayEnd = date.plusDays(1).atStartOfDay();

        List<BookingOrder> booked = bookingMapper.selectList(new LambdaQueryWrapper<BookingOrder>()
                .eq(BookingOrder::getHospitalCode, hospitalCode)
                .eq(BookingOrder::getDepartment, department)
                .ge(BookingOrder::getVisitTime, dayStart)
                .lt(BookingOrder::getVisitTime, dayEnd)
                .ne(BookingOrder::getStatus, "CANCELLED"));

        Map<LocalDateTime, Long> bookedByTime = booked.stream()
                .collect(Collectors.groupingBy(BookingOrder::getVisitTime, Collectors.counting()));

        /*
         * 过滤掉**已经过去的时段**。
         *
         * <p>实测缺陷（2026-11-15 下午）：用户点「确认挂号」后收到
         * 「visitTime 就诊时间必须在将来」—— 因为排程推荐的是当天 08:30，
         * 而当时已是 14:12。日期回退的问题（东八区凌晨用 toISOString 会
         * 退到前一天）之前修过，但**当天上午的时段在下午依然是过去时间**，
         * 这一层当时没滤。
         *
         * <p>为什么不在适配器里滤：适配器代表院方，院方号表里
         * "今天的 08:30" 就是存在的一条记录；是否该给用户看，
         * 是我们业务层的事。也和"扣减余量"放同一层 —— 都是我们
         * 对院方原始数据做加工的地方。
         *
         * <p>边界：查历史日期（date < today）时全部时段都过去，
         * 直接返回空 —— 让上层得到"没号"而不是一堆过去的号。
         */
        LocalDateTime now = LocalDateTime.now();
        if (dayEnd.isAfter(now)) {
            raw = raw.stream()
                    .filter(s -> s.visitTime().isAfter(now))
                    .toList();
        } else {
            return List.of();
        }

        return raw.stream()
                .map(s -> new HospitalAdapter.Slot(
                        s.visitTime(),
                        s.doctorName(),
                        // 不出现负数：号可能被其他渠道占掉，remaining 最低显示 0
                        Math.max(0, s.remaining() - bookedByTime.getOrDefault(s.visitTime(), 0L).intValue())))
                .toList();
    }

    public List<BookingOrder> list(long userId) {
        return bookingMapper.selectList(new LambdaQueryWrapper<BookingOrder>()
                .eq(BookingOrder::getUserId, userId)
                .orderByDesc(BookingOrder::getVisitTime));
    }

    public BookingOrder get(long userId, long id) {
        BookingOrder o = bookingMapper.selectById(id);
        // 不是自己的一律当不存在：报"无权访问"等于确认这个 id 存在
        if (o == null || !o.getUserId().equals(userId)) {
            throw new BizException(40400, "预约单不存在");
        }
        return o;
    }

    /**
     * 建单。
     *
     * <p>顺序很重要：<b>先问院方能不能约，再落库</b>。
     * 反过来先落库再问，院方失败时数据库里会留下一张永远挂着的单，
     * 而提醒引擎会继续为它排提醒 —— 用户收到"明天空腹抽血"，
     * 但那个号根本没约上。
     *
     * <p><b>并发安全</b>：上面那条顺序单独看是错的 ——
     * "都先问院方、都成功、再都落库"会超出容量。所以真正执行的顺序是：
     * <pre>
     *   抢该时段的锁（tryLock，最多等 3 秒）
     *     → 锁内重新查号源（querySlots 已扣掉本地未取消的单）
     *     → remaining &lt;= 0 直接拒绝
     *     → 调院方 book
     *     → 落库
     *   → finally 释放锁，并清掉 map 里的条目
     * </pre>
     *
     * <p><b>为什么锁内要重查号源</b>：{@link HospitalAdapter.Slot} 只有
     * remaining（剩余），没有总容量，适配器也不知道我们本地已经下过几单。
     * 而 {@link #querySlots} 已经把"本地未取消订单"从院方 remaining 里扣掉了，
     * 所以它给出的就是"此刻真正还能约几个"。锁内重查一次，
     * 第二个进来的人看到的就是"已被前一位减过"的数字 —— 不会盲抢。
     * 这样做的额外好处：正确性不完全押在锁上。即便将来多实例部署、
     * 进程内锁失效，锁内重查 + 院方侧的容量控制仍能拦住绝大部分超卖。
     *
     * <p><b>为什么不改适配器接口</b>：{@link HospitalAdapter} 是对院方协议的抽象，
     * 院方只承诺"给你 remaining"。要求它提供"总容量"或"预占"，
     * 等于给每一家待接入的医院加一条它们多半做不到的义务。
     *
     * <p>事务边界：整个方法在一个事务里，锁在事务提交/回滚之后才释放
     * （{@code @Transactional} 的拦截器在外层），所以下一位拿到锁时
     * 能看到上一位已提交的订单。若把锁放在事务内部（例如抽成
     * {@code lockAndCreate} 再自带 {@code @Transactional}），会出现
     * "上一个事务还没提交、下一个已经查到旧数字"的窗口 —— 那正是超卖的成因。
     */
    @Transactional
    public BookingOrder create(long userId, BookingRequest req) {
        HospitalAdapter adapter = adapters.of(req.hospitalCode());

        String key = lockKey(req.hospitalCode(), req.department(), req.visitTime());

        /*
         * computeIfAbsent 而不是 get + put：后者在并发首次进入时
         * 会各自 new 一把锁，两人各拿一把、互不互斥 —— 锁"看起来在，
         * 实际没生效"，是最难察觉的一类并发 bug。
         * computeIfAbsent 对同一个 key 是原子的，保证全场只有一把。
         */
        ReentrantLock lock = slotLocks.computeIfAbsent(key, k -> new ReentrantLock());

        boolean acquired;
        try {
            acquired = lock.tryLock(LOCK_WAIT_MILLIS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new BizException(40903, "预约请求被中断，请稍后重试");
        }

        if (!acquired) {
            /*
             * 没抢到锁：说明同一时段此刻正有别人在走"查号 → 下单 → 落库"，
             * 3 秒都没轮上，说明该时段此刻是热的。
             * 打出来的三项都是院区/科室/时段，属于公开的号源信息，不含患者数据，
             * 排障时需要它们才能判断"是不是某个热门时段被打爆了"。
             */
            log.warn("号源锁等待超时 hospital={} department={} visitTime={} waitedMs={}",
                    req.hospitalCode(), req.department(), req.visitTime(), LOCK_WAIT_MILLIS);
            throw new BizException(40903, "该时段正在被其他人预约，请稍后重试");
        }

        try {
            /*
             * 锁内重查：这是防超卖的关键一步。
             * 必须用 querySlots（已扣本地订单）而不是 adapter.querySlots，
             * 后者给的是院方视角的余量，看不到我们已经下过的单。
             */
            var matched = querySlots(req.hospitalCode(), req.department(), req.visitTime().toLocalDate())
                    .stream()
                    .filter(s -> s.visitTime().equals(req.visitTime()))
                    .findFirst();

            /*
             * ============ 「时段不存在」和「时段满了」必须分开 ============
             *
             * 第一版用 `orElse(0)` 把两者合并，然后统一报"该时段号源已满"。
             * 实测发现这会误导：客户端传了一个号表里根本没有的时间
             * （比如号源只有 08:30 和 14:00，却请求 09:00），
             * 用户看到"已满"，会去换别的时间反复试 —— 而真正的问题是
             * **那个时间从来就不存在**，再试也不会成功。
             *
             * 两种情况的正确指引完全不同：
             *   · 不存在 → 刷新号源列表，从里面挑一个
             *   · 已满   → 换一个时段
             * 对患者来说都是"换时间"，但对我们排查和对上游对齐是两件事。
             */
            if (matched.isEmpty()) {
                log.info("请求的时段不在号源中 hospital={} department={} visitTime={}",
                        req.hospitalCode(), req.department(), req.visitTime());
                throw new BizException(40900,
                        "这个时段已经不可预约了（可能已放完或被院方撤号），请刷新号源后重新选择。");
            }

            if (matched.get().remaining() <= 0) {
                log.info("号源已无余量，拒绝下单 hospital={} department={} visitTime={}",
                        req.hospitalCode(), req.department(), req.visitTime());
                throw new BizException(40900, "该时段号源已满，请换一个时间");
            }

            HospitalAdapter.BookingResult result = adapter.book(req.department(), req.visitTime());
            if (!result.ok()) {
                // 原样带出院方给的原因：用户需要知道"是满了"还是"系统坏了"
                throw new BizException(40900, result.message());
            }

            BookingOrder order = new BookingOrder();
            order.setUserId(userId);
            order.setHospitalCode(req.hospitalCode());
            order.setDepartment(req.department());
            order.setVisitTime(req.visitTime());
            order.setStatus(BookingOrder.STATUS_CREATED);
            order.setExternalOrderNo(result.externalNo());
            order.setRemark(req.remark());
            bookingMapper.insert(order);

            log.info("建预约单 id={} hospital={} external={}",
                    order.getId(), req.hospitalCode(), result.externalNo());
            return order;
        } finally {
            lock.unlock();
            /*
             * ============ 锁的清理（不做这一步 map 会无限增长） ============
             *
             * 锁表的 key 里带 visitTime，而时段是**无限多**的：
             * 每天 × 每个科室 × 每个 30 分钟时段。只 put 不 remove，
             * 跑几个月就是几万个永不释放的 ReentrantLock 常驻堆里 ——
             * 典型的慢性内存泄漏：上线时毫无异样，某天开始 GC 抖动，
             * 而且堆转储里全是一堆看着"无害"的小对象。
             *
             * 为什么必须在 unlock() 之后才 remove：
             *   ReentrantLock 允许按同一线程重入，但只要还有任何线程持有，
             *   过早 remove 会让后来的线程拿到一把**新的**锁 ——
             *   旧锁仍有持有者，新锁无人持有，两把锁保护同一个时段，
             *   等于锁失效。所以顺序只能是"先放锁，再看还有没有人排队"。
             *
             * 为什么还要判 hasQueuedThreads()：unlock 之后、remove 之前的
             * 这一小段时间里，可能有线程已经通过 tryLock 排上了队。
             * 把它删掉，排队者醒来时用的是旧锁对象，而删掉后新来的人
             * 会 computeIfAbsent 出另一把新锁 —— 同样是两把锁并存。
             * 所以只在"无人排队"时才删；有人排队就留着，等他自己释放时再删。
             *
             * 注意：remove(key, lock) 而不是 remove(key)。前者只在
             * 当前映射值仍是这把锁时才删，避免误删别的线程刚重建的新锁。
             * 这也是 javac 层面看不出来的地方 —— 一个真实存在的竞态。
             */
            if (!lock.isHeldByCurrentThread() && !lock.hasQueuedThreads()) {
                slotLocks.remove(key, lock);
            }
        }
    }

    /** 当前锁表规模，仅测试与排查用 —— 用来验证上面的清理逻辑真的生效 */
    public int activeLockCount() {
        return slotLocks.size();
    }

    /**
     * 自助签到：记下"患者说他已经到医院了"这个时间点。
     *
     * <p><b>它不改状态</b>。签到之后单子仍是 CONFIRMED ——
     * 签到不是流程状态，只是一个时间戳。把它做成状态会让
     * "能不能取消""还能不能改约"这些判断全部多一个分支，
     * 而那些判断跟"人到没到"其实没有关系。
     *
     * <p><b>幂等</b>：已经有 checkinAt 就直接返回，不覆盖。
     * 理由见 Controller 的注释（多点两下不该让估算来回跳）。
     *
     * <p>已取消的单不允许签到：那个号已经不在他名下了，
     * 签到一个无效的单只会让他到诊室时才发现问题。
     */
    @Transactional
    public BookingOrder checkIn(long userId, long id) {
        BookingOrder order = get(userId, id);

        if (BookingOrder.STATUS_CANCELLED.equals(order.getStatus())) {
            throw new BizException(40904, "这个预约已经取消了，无法签到。请现场挂号或到分诊台咨询。");
        }

        if (order.getCheckinAt() != null) {
            // 已经签过，原样返回 —— 幂等
            return order;
        }

        order.setCheckinAt(LocalDateTime.now());
        bookingMapper.updateById(order);
        log.info("患者自助签到 order={} hospital={}", id, order.getHospitalCode());
        return order;
    }

    @Transactional
    public BookingOrder changeStatus(long userId, long id, String target) {
        BookingOrder order = get(userId, id);
        String current = order.getStatus();

        Set<String> allowed = TRANSITIONS.getOrDefault(current, Set.of());
        if (!allowed.contains(target)) {
            throw new BizException(40901,
                    "当前状态（" + label(current) + "）不能变成" + label(target));
        }

        // 取消要回问院方：本地改状态但院方那边还占着号，是最坏的"看起来取消了" 
        if (BookingOrder.STATUS_CANCELLED.equals(target)) {
            HospitalAdapter adapter = adapters.of(order.getHospitalCode());
            HospitalAdapter.BookingResult r = adapter.cancel(order.getExternalOrderNo());
            if (!r.ok()) {
                throw new BizException(40902, "院方取消失败：" + r.message());
            }
        }

        order.setStatus(target);
        bookingMapper.updateById(order);
        log.info("预约单 {} 状态 {} -> {}", id, current, target);
        return order;
    }

    private String label(String status) {
        return switch (status == null ? "" : status) {
            case BookingOrder.STATUS_CREATED -> "待确认";
            case BookingOrder.STATUS_CONFIRMED -> "已确认";
            case BookingOrder.STATUS_COMPLETED -> "已完成";
            case BookingOrder.STATUS_CANCELLED -> "已取消";
            default -> status;
        };
    }
}
