/* ------------------------------------------------------------------
 * Scheduler 测试
 *
 * 分两块：
 *   1. 纯函数（意图抽取 / 日期解析 / 时间线）—— 可完全离线测
 *   2. Agent 主流程 —— mock fetch，验证"不同失败给不同话术"
 *
 * 重点在**失败分类**：号源服务挂掉、科室不存在、真没号，
 * 三种情况用户该做的事完全不同。笼统说"查询失败"等于没说。
 * ------------------------------------------------------------------ */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTimeline, parseBookingIntent, parseDate } from './scheduler';

/* ============================ 测试替身 ============================ */

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ code: 0, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 模拟"院方目录正常 + 号源正常"。
 *
 * <p>为什么按 URL 分流而不是一律返回同一份数据：
 * 排程现在会先问目录（挂到哪个科、叫什么名），再问号源。
 * 一份数据同时喂给两个接口，测出来的是"两个接口被同一份数据骗过"，
 * 不是真实链路。
 */
function stubCatalogAndSlots() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/hospitals/catalog')) {
        return jsonResponse([
          {
            code: 'Z2-JFL',
            name: '浙江大学医学院附属第二医院（解放路院区）（演示）',
            departments: ['内分泌科', '消化内科'],
          },
        ]);
      }
      return jsonResponse([
        { visitTime: '2026-11-16T08:30:00', doctorName: '内分泌科 · 演示医生A', remaining: 2 },
      ]);
    }),
  );
}

/* ============================ 意图抽取 ============================ */

describe('科室抽取', () => {
  it('显式科室名直接命中', () => {
    expect(parseBookingIntent('我想挂内分泌科')?.department).toBe('内分泌科');
    expect(parseBookingIntent('帮我约心血管内科')?.department).toBe('心血管内科');
  });

  it('口语别名映射到标准科室名', () => {
    // 用户说"心内科"，后端只认"心血管内科" —— 不映射会查到空号源
    expect(parseBookingIntent('想挂个心内科')?.department).toBe('心血管内科');
    expect(parseBookingIntent('我要看血糖')?.department).toBe('内分泌科');
    expect(parseBookingIntent('肚子不舒服想挂号')?.department).toBe('消化内科');
  });

  it('抽不到科室返回 null，不瞎猜', () => {
    expect(parseBookingIntent('我想挂号')).toBeNull();
    expect(parseBookingIntent('')).toBeNull();
    expect(parseBookingIntent('随便看看')).toBeNull();
  });

  it('空输入不崩', () => {
    expect(() => parseBookingIntent('   ')).not.toThrow();
  });
});

describe('院区抽取', () => {
  /*
   * 只保留浙二解放路一家演示院区。
   *
   * 原来的两个 MOCK 院区叫「演示市第一人民医院」「演示市中心医院」——
   * 既不像真实医院，也说不清自己在演示什么。现在换成一家真实名称
   * 加「（演示）」角标的院区，识别规则也相应精简。
   *
   * 这里测的是"口语 → 编码"这一层映射；医院的**属性**（展示名、开设科室）
   * 一律来自院方目录，不在这里断言 —— 那正是我们要消除的第二份真相。
   */
  it('口语里的"浙二""解放路"都指向同一家', () => {
    expect(parseBookingIntent('想约浙二内分泌科')?.hospitalCode).toBe('Z2-JFL');
    expect(parseBookingIntent('去解放路院区挂内分泌科')?.hospitalCode).toBe('Z2-JFL');
    expect(parseBookingIntent('浙江大学医学院附属第二医院 消化内科')?.hospitalCode).toBe('Z2-JFL');
  });

  it('没提院区时返回 null（由调用方按院方目录查）', () => {
    expect(parseBookingIntent('挂内分泌科')?.hospitalCode).toBeNull();
  });
});

describe('日期解析', () => {
  // 固定基准：2026-11-15 是周日
  const NOW = new Date('2026-11-15T10:00:00');

  it('今天 / 明天 / 后天', () => {
    expect(parseDate('今天', NOW)).toBe('2026-11-15');
    expect(parseDate('明天', NOW)).toBe('2026-11-16');
    expect(parseDate('后天', NOW)).toBe('2026-11-17');
  });

  it('星期几', () => {
    // 11-15 是周日，周三应是 11-18
    expect(parseDate('周三', NOW)).toBe('2026-11-18');
    expect(parseDate('下周三', NOW)).toBe('2026-11-25');
  });

  it('几月几号', () => {
    expect(parseDate('12月3日', NOW)).toBe('2026-12-03');
    expect(parseDate('11月20号', NOW)).toBe('2026-11-20');
  });

  it('说过去的月份理解为明年', () => {
    // 现在是 11 月，说"3月5日"应该指明年
    expect(parseDate('3月5日', NOW)).toBe('2027-03-05');
  });

  it('非法日期不产生结果', () => {
    expect(parseDate('13月45日', NOW)).toBeNull();
    expect(parseDate('随便哪天', NOW)).toBeNull();
  });

  it('抽不到日期返回 null（调用方查最近可用）', () => {
    expect(parseDate('挂内分泌科', NOW)).toBeNull();
  });

  /**
   * 时区缺陷回归：东八区凌晨用 toISOString 会退到前一天。
   *
   * 实测：本地 2026-11-15 01:45，toISOString() 得到 "2026-11-14"，
   * 于是排程查到的是已经过去的号 —— 用户看到一个过期时段。
   * 这条用例锁住"用本地时区"这件事。
   */
  it('凌晨（本地日期与 UTC 不同）仍按本地时区算', () => {
    // 构造本地时间 01:45，此时 UTC 还是前一天
    const earlyMorning = new Date(2026, 10, 15, 1, 45); // 本地 2026-11-15 01:45
    expect(parseDate('今天', earlyMorning)).toBe('2026-11-15');
    expect(parseDate('明天', earlyMorning)).toBe('2026-11-16');
  });
});

/* ============================ 时间线 ============================ */

describe('就诊时间线', () => {
  it('内分泌科需要空腹，抽血排第一', () => {
    const t = buildTimeline('内分泌科', '2026-11-16T08:30:00');
    expect(t[0]!.task).toContain('空腹抽血');
    expect(t[0]!.note).toContain('禁食');
  });

  it('骨科不需要空腹抽血', () => {
    const t = buildTimeline('骨科', '2026-11-16T09:00:00');
    expect(t.some((x) => x.task.includes('空腹抽血'))).toBe(false);
  });

  it('见医生这一步依赖抽血（有依赖关系才叫时间线）', () => {
    const t = buildTimeline('内分泌科', '2026-11-16T08:30:00');
    const seeDoc = t.find((x) => x.task.includes('见') && x.task.includes('医生'));
    expect(seeDoc?.dependsOn).toContain('空腹抽血');
  });

  it('order 连续递增，从 1 开始', () => {
    const t = buildTimeline('内分泌科', '2026-11-16T08:30:00');
    expect(t.map((x) => x.order)).toEqual([1, 2, 3, 4]);
  });

  it('没有预约时间时不崩', () => {
    expect(() => buildTimeline('骨科', '')).not.toThrow();
  });
});

/* ============================ Agent 主流程 ============================ */

const mkInput = (text: string) => ({
  turnId: 't',
  sessionId: 's',
  userId: 'u',
  payload: { text },
  facts: {
    allergies: [],
    chronicConditions: [],
    currentMedications: [],
    bookingState: null,
  },
  memory: { window: [], summary: null, semanticHits: [] },
});

describe('Agent：失败要给不同的话术', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('后端连不上 → caveat 明确说"后端未启动"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );
    const { makeScheduler } = await import('./scheduler');
    const out = await makeScheduler()(mkInput('挂内分泌科'));
    expect(out.status).toBe('failed');
    const caveat = out.events.find((e) => e.type === 'caveat');
    expect(caveat && 'text' in caveat ? caveat.text : '').toContain('后端');
  });

  it('抽不到科室 → 追问而不是猜一个科', async () => {
    const { makeScheduler } = await import('./scheduler');
    const out = await makeScheduler()(mkInput('我想挂个号'));
    expect(out.status).toBe('need_clarify');
    expect(out.events.some((e) => e.type === 'clarify')).toBe(true);
  });

  it('两周内都没号 → 说清楚，不假装成功', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 0, data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const { makeScheduler } = await import('./scheduler');
    const out = await makeScheduler()(mkInput('挂内分泌科'));
    expect(out.payload.preview).toBeNull();
    const caveat = out.events.find((e) => e.type === 'caveat');
    expect(caveat && 'text' in caveat ? caveat.text : '').toContain('没有可预约的号源');
  });

  it('有号 → 发出 booking_preview_card 与 timeline_card', async () => {
    stubCatalogAndSlots();
    const { makeScheduler } = await import('./scheduler');
    const out = await makeScheduler()(mkInput('挂内分泌科'));
    expect(out.events.some((e) => e.type === 'booking_preview_card')).toBe(true);
    expect(out.events.some((e) => e.type === 'timeline_card')).toBe(true);
    // 预览必须带 hospitalCode，否则前端无法下单
    expect(out.payload.preview?.hospitalCode).toBe('Z2-JFL');
    // 展示名来自院方目录，且必须带「（演示）」—— 这是不许丢的合规角标
    expect(out.payload.preview?.hospital).toContain('演示');
  });

  it('院区没开这个科 → 在给预览之前就说清楚，不白查一轮', async () => {
    /*
     * 这是加了院方目录之后才能做到的检查：
     * 用户问一个院区没有的科室，以前会查 14 天，最后回一句
     * "最近两周没有号源"—— 听起来像"号放完了"，
     * 实际是"这家医院根本没这个科"。两者用户该做的事完全不同。
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes('/hospitals/catalog')) {
          return jsonResponse([
            { code: 'Z2-JFL', name: '某某医院（演示）', departments: ['内分泌科'] },
          ]);
        }
        return jsonResponse([]);
      }),
    );
    const { makeScheduler } = await import('./scheduler');
    const out = await makeScheduler()(mkInput('挂皮肤科'));
    expect(out.payload.preview).toBeNull();
    const caveat = out.events.find((e) => e.type === 'caveat');
    expect(caveat && 'text' in caveat ? caveat.text : '').toContain('暂时没有');
  });

  it('Agent 内部异常不抛出（safeRun 兜底）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('unexpected');
      }),
    );
    const { makeScheduler } = await import('./scheduler');
    await expect(makeScheduler()(mkInput('挂内分泌科'))).resolves.toBeDefined();
  });
});
