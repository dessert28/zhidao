package com.zhidao.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhidao.adapter.HospitalAdapter;
import com.zhidao.adapter.HospitalAdapterRegistry;
import com.zhidao.common.BizException;
import com.zhidao.dto.BookingRequest;
import com.zhidao.entity.BookingOrder;
import com.zhidao.mapper.BookingOrderMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 号源并发安全测试。
 *
 * <p>锁住的是订票系统里最贵的一类 bug：<b>超卖</b>。
 * 原来的 create() 是"先问院方再落库"，两个并发请求都会看到同样的余量、
 * 都通过检查、都落库 —— 该时段卖出的人数超过容量。
 * 这种问题在单线程测试里永远看不见，只会在上线后的高峰出现，
 * 而且现场无法复现（日志里两个请求时间戳一模一样，看上去都很"正常"）。
 *
 * <h3>为什么这个用例不能加 @Transactional</h3>
 *
 * <p>项目里其余测试都靠 {@code @Transactional} 回滚，这里刻意<b>不加</b>：
 * 事务只能绑定在发起它的那个线程上。测试线程开的事务对下面的
 * worker 线程不可见 —— 每个 worker 走自己的连接、自己的事务，
 * 根本看不到测试线程准备的数据，而且 worker 的写入也不会被回滚。
 * 更要紧的是：锁的正确性恰恰依赖"上一位的订单已提交，下一位才看得到"，
 * 用一个全局回滚的事务去测它，测的就不是真实路径了。
 * 所以这里自己清理数据（{@link #clean()}）。
 *
 * <p>user_id 是必填列，测试里统一挂在演示账号 1 上。业务本来就不按用户限购
 * （同一个人给家人约两个号是正常的），并发场景下也用同一个 id 才能真实验证
 * "两个人抢同一个号"。
 */
@SpringBootTest
@DisplayName("号源并发：同时预约的通过数不超过该时段的余量")
class BookingConcurrencyTest {

    /**
     * 用真实科室名，不能用自造的"并发测试科"。
     *
     * <p>{@link com.zhidao.adapter.MockHospitalAdapter} 的号源是按
     * {@code dailyQuota} 里的科室放出来的，未配置的科室 {@code querySlots}
     * 直接返回空 —— 第一次跑这条用例时就是在这里踩空的：
     * 前置断言"该时段应有余量"拿到 0，测试连并发步骤都没走到。
     *
     * <p>为了不和种子数据里的演示预约以及同批其他测试用例抢号，
     * 日期取 {@code now + 7 天}（种子数据都在 2026-11 前后），
     * 时段取下午 15:30（Mock 下午号从 14:00 起每 30 分钟一个，
     * 心血管内科每天 4 个号 → 上午 2 个、下午 2 个，15:30 一定在号表里）。
     */
    private static final String DEPT = "心血管内科";

    /** 抢同一个时段的人数，远大于 Mock 每个时段的容量（3），确保"必须有人失败" */
    private static final int THREADS = 16;

    @Autowired
    private BookingService bookingService;

    @Autowired
    private BookingOrderMapper bookingMapper;

    @Autowired
    private HospitalAdapterRegistry adapters;

    /**
     * 每次跑测试时重新挑时段，避免和数据.sql 里已有的演示预约撞在同一个时段。
     *
     * <p>时段**必须从号源里取，不能写死钟点**：号表是按科室额度生成的
     * （心血管内科每天 4 个号 → 上午 8:30/9:00、下午 14:00/14:30），
     * 写死"15:30"看起来合理，实际上根本不在号表里，
     * 前置断言拿到 0、测试连并发步骤都走不到 —— 这个坑踩过一次。
     */
    private LocalDateTime visitTime;

    /** 与被抢时段相邻的另一个时段，用于验证"锁的粒度不串" */
    private LocalDateTime neighbourTime;

    @BeforeEach
    void setUp() {
        clean();
        LocalDate date = LocalDate.now().plusDays(7);
        List<HospitalAdapter.Slot> slots =
                bookingService.querySlots(HospitalAdapterRegistry.DEMO_CODE, DEPT, date);
        assertThat(slots)
                .as("前置条件：演示院区的「%s」在 %s 应有号源 —— 没有的话是号源模型变了，"
                        + "不是并发逻辑坏了", DEPT, date)
                .isNotEmpty();

        visitTime = slots.get(0).visitTime();
        neighbourTime = slots.size() > 1
                ? slots.get(1).visitTime()
                // 只有一个号时，邻时段取 30 分钟后；那条用例会自己再断言它有余量
                : visitTime.plusMinutes(30);
    }

    /**
     * 清掉这个科室当天我们造出来的订单，<b>并且回问院方取消</b>。
     *
     * <p>只删库不够：{@link com.zhidao.adapter.MockHospitalAdapter} 的
     * 名额记在它自己的进程内 Map 里（{@code orders}），一个 Spring 测试上下文
     * 期间所有用例共用一个实例。前面那条 16 线程的并发用例把该时段
     * 3 个号全占满了，只删库却不调 cancel，下一条用例看到的就是
     * "院方说没号、库里却干干净净" —— 表现为前置断言全过、
     * 第一单就被拒，很容易被误判成锁出了问题而改错地方。
     *
     * <p>Mock 的 cancel 是幂等的（不存在也返回成功），所以不需要先判断存在。
     */
    @BeforeEach
    void clean() {
        LocalDate date = LocalDate.now().plusDays(7);
        List<BookingOrder> mine = bookingMapper.selectList(new LambdaQueryWrapper<BookingOrder>()
                .eq(BookingOrder::getDepartment, DEPT)
                .ge(BookingOrder::getVisitTime, date.atStartOfDay())
                .lt(BookingOrder::getVisitTime, date.plusDays(1).atStartOfDay()));

        HospitalAdapter adapter = adapters.of(HospitalAdapterRegistry.DEMO_CODE);
        for (BookingOrder o : mine) {
            adapter.cancel(o.getExternalOrderNo());
        }

        bookingMapper.delete(new LambdaQueryWrapper<BookingOrder>()
                .eq(BookingOrder::getDepartment, DEPT)
                .ge(BookingOrder::getVisitTime, date.atStartOfDay())
                .lt(BookingOrder::getVisitTime, date.plusDays(1).atStartOfDay()));
    }

    private long remainingAt(LocalDateTime time) {
        return bookingService.querySlots(HospitalAdapterRegistry.DEMO_CODE, DEPT, time.toLocalDate())
                .stream()
                .filter(s -> s.visitTime().equals(time))
                .mapToInt(HospitalAdapter.Slot::remaining)
                .findFirst()
                .orElse(0);
    }

    private long bookedAt(LocalDateTime time) {
        return bookingMapper.selectCount(new LambdaQueryWrapper<BookingOrder>()
                .eq(BookingOrder::getHospitalCode, HospitalAdapterRegistry.DEMO_CODE)
                .eq(BookingOrder::getDepartment, DEPT)
                .eq(BookingOrder::getVisitTime, time)
                .ne(BookingOrder::getStatus, BookingOrder.STATUS_CANCELLED));
    }

    /**
     * 让 N 个线程在同一瞬间起跑。
     *
     * <p>两道闸门：第一道让所有线程都就位，第二道才同时放开 ——
     * 如果只用一个 latch，先创建的线程会陆续跑完，
     * 并发度被拉开，超卖根本不会触发，测试就成了"假绿"。
     */
    private List<Throwable> runConcurrently(int threads, Runnable task) throws InterruptedException {
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch ready = new CountDownLatch(threads);
        CountDownLatch go = new CountDownLatch(1);
        List<Throwable> errors = java.util.Collections.synchronizedList(new ArrayList<>());

        try {
            for (int i = 0; i < threads; i++) {
                pool.submit(() -> {
                    ready.countDown();
                    try {
                        go.await();
                        task.run();
                    } catch (Throwable t) {
                        errors.add(t);
                    }
                });
            }
            assertThat(ready.await(10, TimeUnit.SECONDS))
                    .as("所有线程应在 10 秒内就位")
                    .isTrue();
            go.countDown();
            pool.shutdown();
            assertThat(pool.awaitTermination(60, TimeUnit.SECONDS))
                    .as("并发任务应在 60 秒内全部结束（否则多半是锁没释放导致死等）")
                    .isTrue();
        } finally {
            pool.shutdownNow();
        }
        return errors;
    }

    /* ============================ 核心：不超卖 ============================ */

    @Test
    @DisplayName("16 个线程同时约同一时段 → 成功数不超过当时的余量，且库里的单数也一致")
    void concurrentBookingNeverOversells() throws InterruptedException {
        int quota = (int) remainingAt(visitTime);
        assertThat(quota)
                .as("前置条件：该时段应有初始余量（演示院区每个时段放 3 个号）")
                .isGreaterThan(0);

        AtomicInteger success = new AtomicInteger();
        AtomicInteger rejected = new AtomicInteger();

        List<Throwable> errors = runConcurrently(THREADS, () -> {
            try {
                bookingService.create(1L,
                        new BookingRequest(HospitalAdapterRegistry.DEMO_CODE, DEPT, visitTime, null));
                success.incrementAndGet();
            } catch (BizException e) {
                /*
                 * 被拒是预期结果之一，但**原因必须是"没号了"或"正在被别人约"**。
                 * 如果抛出的是别的业务异常（比如院区不存在），说明测试前提坏了，
                 * 要让它冒到 errors 里暴露出来，而不是被这里悄悄吞掉当成"正常拒绝"。
                 */
                if (e.getCode() == 40900 || e.getCode() == 40903) {
                    rejected.incrementAndGet();
                } else {
                    throw e;
                }
            }
        });

        assertThat(errors)
                .as("不应出现非业务异常（任何未预期异常都意味着并发路径上有 bug）")
                .isEmpty();

        assertThat(success.get())
                .as("成功数不得超过该时段的余量 %d —— 超出即是超卖", quota)
                .isLessThanOrEqualTo(quota);

        assertThat(bookedAt(visitTime))
                .as("库里的订单数必须与成功数一致（院方成功但落库失败同样是坏结果）")
                .isEqualTo(success.get());

        assertThat(success.get() + rejected.get())
                .as("每个线程都应有明确结论：要么成功，要么被业务规则拒绝，不能静默丢失")
                .isEqualTo(THREADS);

        assertThat(remainingAt(visitTime))
                .as("并发结束后余量应正好减到 0（成功数 = 初始余量时）")
                .isEqualTo(Math.max(0, quota - success.get()));
    }

    @Test
    @DisplayName("并发结束后锁表被清理干净 —— 否则按天×科室×时段无限增长")
    void locksAreReleasedAfterBurst() throws InterruptedException {
        runConcurrently(THREADS, () -> {
            try {
                bookingService.create(1L,
                        new BookingRequest(HospitalAdapterRegistry.DEMO_CODE, DEPT, visitTime, null));
            } catch (BizException ignored) {
                // 这一条只关心锁的清理，被拒与否无关紧要
            }
        });

        /*
         * 留一点余量：最后一个线程 unlock 之后到它执行 remove 之间是几微秒的窗口，
         * 严格断言等于 0 会偶发失败（这种 flaky 测试比没有测试更糟）。
         * 用轮询等待代替 Thread.sleep，正常情况下一两轮就收敛。
         */
        int left = bookingService.activeLockCount();
        for (int i = 0; i < 50 && left > 0; i++) {
            Thread.sleep(20);
            left = bookingService.activeLockCount();
        }
        assertThat(left)
                .as("一次并发高峰过后锁表应回到 0；若持续增长，就是 unlimited 的内存泄漏")
                .isZero();
    }

    /* ============================ 串行本身：余量递减可见 ============================ */

    @Test
    @DisplayName("逐个预约时余量每次减 1 —— 证明锁内重查拿到的是已扣减的数字")
    void sequentialBookingsSeeDecrementedRemaining() {
        int quota = (int) remainingAt(visitTime);
        assertThat(quota).isGreaterThan(0);

        for (int i = 0; i < quota; i++) {
            bookingService.create(1L,
                    new BookingRequest(HospitalAdapterRegistry.DEMO_CODE, DEPT, visitTime, null));
            assertThat(remainingAt(visitTime))
                    .as("第 %d 次下单后余量应递减", i + 1)
                    .isEqualTo(quota - i - 1);
        }

        org.assertj.core.api.Assertions.assertThatThrownBy(() ->
                        bookingService.create(1L,
                                new BookingRequest(HospitalAdapterRegistry.DEMO_CODE, DEPT, visitTime, null)))
                .as("余量耗尽后再约必须被拒")
                .isInstanceOf(BizException.class);
    }

    @Test
    @DisplayName("不同时段的锁互不影响 —— 粒度按院区+科室+时段，不能串成全局锁")
    void differentSlotsDoNotBlockEachOther() throws InterruptedException {
        LocalDateTime other = neighbourTime;
        assertThat(remainingAt(other))
                .as("前置条件：相邻时段也应有号，否则这条用例没有意义")
                .isGreaterThan(0);

        LocalDateTime[] targets = {visitTime, other};
        AtomicInteger ok = new AtomicInteger();

        runConcurrently(8, () -> {
            // 一半抢 A 时段，一半抢 B 时段；两个时段各自独立，不该互相拖慢
            LocalDateTime t = targets[(int) (Thread.currentThread().getId() % 2)];
            try {
                bookingService.create(1L,
                        new BookingRequest(HospitalAdapterRegistry.DEMO_CODE, DEPT, t, null));
                ok.incrementAndGet();
            } catch (BizException ignored) {
                // 各自时段的名额有限，被拒是正常的
            }
        });

        assertThat(bookedAt(visitTime) + bookedAt(other))
                .as("两个时段各自独立成单，总成功数应等于实际落库数")
                .isEqualTo(ok.get());
        assertThat(ok.get())
                .as("两个时段各有容量，全部落空说明锁把本可以成功的人挡住了")
                .isGreaterThan(0);
    }
}
