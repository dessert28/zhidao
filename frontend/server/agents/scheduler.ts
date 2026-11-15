/* ------------------------------------------------------------------
 * Scheduler Agent —— 号源查询与预约预览
 * 依据：docs/05 §3、docs/03 §2 的第 2 段「在院内」
 *
 * ============ 它解决什么 ============
 *
 * 这是"三段式"里唯一空着的一段。之前 chat.ts 的 schedule 分支
 * 只回一句「功能正在接入中」——用户说"我想挂内分泌科"什么也得不到。
 *
 * ============ 架构位置（这条必须守住） ============
 *
 * Scheduler 跑在 Node BFF，**不直连院区**，而是调 Spring Boot 的
 * `/api/bookings/*`（见 docs/03 L108：Scheduler → 工具层 → 医院 A/B）。
 *
 * 为什么不直连：
 *   · 院区适配器（HospitalAdapter）与它的注册表在后端，
 *     业务规则（状态机、下单前先问院方）也在后端
 *   · BFF 直连等于把院区协议引到 AI 层，两份实现必然分叉
 *     （docs/10 D1 的同一理由：AI 编排只在前端，业务只在后端）
 *
 * ============ 边界：只能预览，不能直接下单 ============
 *
 * 这个 Agent 只做「查号源 + 给建议」，**不创建预约单**。
 * 下单是用户看完预览后主动点的动作（前端调 POST /api/bookings）。
 *
 * 理由和用药冲突一致：挂号是有后果的操作（占号、影响别人），
 * AI 在没有用户确认的情况下替人下单，出了错无法回滚到"用户没同意"。
 * 所以这里只给 booking_preview_card，把"确认"留给人。
 * ------------------------------------------------------------------ */

import type {
  AgentInput,
  AgentOutput,
  BookingPreview,
  SchedulerPayload,
  TimelineTask,
} from '@shared/types/contract';
import type { AgentEvent } from '@shared/types/events';
import { emptyOutput, safeRun } from './safe-run.js';
// 院方能力走工具层（MCP 形状，见 docs/10 D3）。
// 不在这里直接 fetch：超时与错误分类由工具层统一做一份。
import { listSlots, type SlotDto } from './tools/mcp-hospital.js';

export const SCHEDULER_TIMEOUT_MS = 8000;

/* ============================ 意图抽取 ============================ */

export interface BookingIntent {
  /** 科室名，如"内分泌科" */
  department: string;
  /** 院区编码，没提到则为 null（由调用方决定用哪家） */
  hospitalCode: string | null;
  /** 期望日期，没提到则为 null（默认查最近可用） */
  date: string | null;
}

/**
 * 中文科室名 → 后端使用的标准名。
 *
 * <p>为什么要一张表：用户说"想挂心内科"，后端只认"心血管内科"。
 * 直接透传会让号源查询返回空，用户以为没号 —— 这比不提示更糟。
 */
const DEPARTMENT_ALIASES: Array<[RegExp, string]> = [
  [/心内科|心脏病|冠心病/, '心血管内科'],
  [/内分泌|血糖|糖尿|甲状腺/, '内分泌科'],
  [/消化|胃肠|肚子|胃疼|胃痛/, '消化内科'],
  [/呼吸|咳嗽|气喘|肺部/, '呼吸内科'],
  [/神经内科|头晕|头痛|偏头痛|失眠/, '神经内科'],
  [/骨科|关节|腰|颈椎|膝盖/, '骨科'],
  [/皮肤|皮疹|瘙痒|过敏/, '皮肤科'],
  [/妇科|月经|痛经|白带/, '妇科'],
  [/眼睛|视力|眼科/, '眼科'],
  [/牙|口腔|牙龈/, '口腔科'],
  [/耳朵|咽喉|嗓子|鼻子|耳鸣/, '耳鼻咽喉科'],
];

/** 用户口语里的科室名列表，用于兜底匹配（后端已注册的科室） */
const KNOWN_DEPARTMENTS = [
  '心血管内科',
  '内分泌科',
  '消化内科',
  '呼吸内科',
  '神经内科',
  '骨科',
  '皮肤科',
  '妇科',
  '眼科',
  '口腔科',
  '耳鼻咽喉科',
  '全科医学科',
];

/**
 * 从用户这句话里抽出登挂号意图。
 *
 * @returns 抽不到科室时返回 null —— 交给调用方回一句"要挂哪个科"，
 *          不要瞎猜一个科去查号（那会给出一个用户没打算挂的号）
 */
export function parseBookingIntent(text: string): BookingIntent | null {
  const t = text.trim();
  if (!t) return null;

  // 1. 科室：先试显式科室名，再试别名
  let department: string | null = null;
  for (const d of KNOWN_DEPARTMENTS) {
    if (t.includes(d)) {
      department = d;
      break;
    }
  }
  if (!department) {
    for (const [pattern, name] of DEPARTMENT_ALIASES) {
      if (pattern.test(t)) {
        department = name;
        break;
      }
    }
  }
  if (!department) return null;

  // 2. 院区：按名称识别；识别不到留空，由调用方决定用哪家
  /*
   * 顺序有讲究：**先匹配"浙二/浙大二院"，再匹配泛化的"人民医院"**。
   * 「浙江大学医学院附属第二医院」里含"第二医院"，
   * 如果先写了 /第二/ 这类宽泛规则会误命中别家。
   */
  let hospitalCode: string | null = null;
  if (/浙(大|江大学.*第)?二院|浙二|第二医院|解放路/i.test(t)) hospitalCode = 'Z2-JFL';
  else if (/第一人民|人民医院|MOCK-A/i.test(t)) hospitalCode = 'MOCK-A';
  else if (/中心医院|MOCK-B/i.test(t)) hospitalCode = 'MOCK-B';

  // 3. 日期：支持"明天""后天""下周X""X月X日"，抽不到留空
  const date = parseDate(t);

  return { department, hospitalCode, date };
}

/**
 * 从话里抽日期，返回 YYYY-MM-DD。
 *
 * <p>抽不到返回 null —— 调用方会去查"最近可用"，
 * 而不是假设用户想今天来（今天往往没号，会让用户以为系统坏了）。
 */
export function parseDate(text: string, now = new Date()): string | null {
  const pad = (n: number) => String(n).padStart(2, '0');
  /*
   * 一律按**本地时区**格式化。
   * 用 toISOString 会在东八区凌晨退到前一天（实测缺陷，见 todayLocal 注释）。
   */
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (n: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    return fmt(d);
  };

  if (/今天|今日/.test(text)) return addDays(0);
  if (/明天|明日/.test(text)) return addDays(1);
  if (/后天/.test(text)) return addDays(2);

  const weekdays: Array<[RegExp, number]> = [
    [/下?周[一1]/, 1],
    [/下?周[二2]/, 2],
    [/下?周[三3]/, 3],
    [/下?周[四4]/, 4],
    [/下?周[五5]/, 5],
    [/下?周[六6]/, 6],
    [/下?周[日天]/, 0],
  ];
  for (const [pattern, target] of weekdays) {
    if (pattern.test(text)) {
      const cur = now.getDay();
      let delta = (target - cur + 7) % 7;
      // "下周三"：本周已过的话再推一周
      if (/下周/.test(text) && delta < 7) delta += 7;
      if (delta === 0) delta = 7;
      return addDays(delta);
    }
  }

  const m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = month < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear();
      return `${year}-${pad(month)}-${pad(day)}`;
    }
  }

  return null;
}

/* ============================ 后端调用（经工具层） ============================ */

type SlotQueryResult =
  | { ok: true; slots: SlotDto[]; hospitalCode: string }
  | { ok: false; reason: 'unreachable' | 'no_department' | 'empty'; hospitalCode: string };

/**
 * 查某个院区某科室的号源。
 *
 * <p>实现改为走工具层（`tools/mcp-hospital.ts` 的 `listSlots`），
 * 不再在这里直接 fetch —— 工具层统一做超时、错误分类，
 * 而且签名与 MCP tool schema 对齐（docs/10 D3），
 * 将来换 transport 不用动这个 Agent。
 *
 * <p>这里只把工具的三态结果翻译成本 Agent 需要的四种情况：
 * 三种失败给三种话术 —— "后端没起"让用户去起服务，
 * "这个院区没这个科"该换院区，"没号"该换日期。
 * 笼统说"查询失败"等于什么都没说。
 */
async function querySlots(
  hospitalCode: string,
  department: string,
  date: string,
): Promise<SlotQueryResult> {
  const r = await listSlots.handler({ hospitalCode, department, date });

  if (r.status === 'ok') {
    return { ok: true, slots: r.data, hospitalCode };
  }
  if (r.status === 'empty') {
    return { ok: false, reason: 'empty', hospitalCode };
  }
  return {
    ok: false,
    reason: r.reason === 'not_found' ? 'no_department' : 'unreachable',
    hospitalCode,
  };
}

/** 院区编码 → 展示名 */
const HOSPITAL_NAMES: Record<string, string> = {
  'MOCK-A': '演示市第一人民医院',
  'MOCK-B': '演示市中心医院',
  // 用户口语里叫「浙二」，官方名太长 —— 展示时用简称，卡片里再给全称
  'Z2-JFL': '浙大二院（解放路院区）',
};

function hospitalName(code: string): string {
  return HOSPITAL_NAMES[code] ?? code;
}

/**
 * 本地时区的今天，YYYY-MM-DD。
 *
 * <p><b>不能用 `toISOString().slice(0,10)`</b>：那个给的是 **UTC** 日期。
 * 在东八区凌晨 0-8 点，UTC 还停在前一天 —— 实测凌晨 1:45 查到的是
 * 「11-14 08:30」这个已经过去的号，用户会看到一个过期时段。
 *
 * <p>`toLocaleDateString('sv-SE')` 恰好输出 YYYY-MM-DD 且按本地时区，
 * 这是用它而不是手动拼 getFullYear 的原因：少三行代码、少三处出错点。
 */
function todayLocal(now = new Date()): string {
  return now.toLocaleDateString('sv-SE');
}

/** 往后找最近一个有号的日期（含今天），最多看 14 天 */
function nextDays(from: string, count: number): string[] {
  // 用「年月日」构造再格式化，避免 new Date('YYYY-MM-DD') 被当成 UTC 午夜
  const [y, m, d] = from.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const dt = new Date(y!, (m ?? 1) - 1, d!);
    dt.setDate(dt.getDate() + i);
    out.push(dt.toLocaleDateString('sv-SE'));
  }
  return out;
}

/* ============================ 就诊时间轴 ============================ */

/**
 * 生成就诊当日的时间线。
 *
 * <p>为什么值得做：这是"少跑腿"最具体的一条 ——
 * 先抽血还是先拍片，直接影响要不要空腹、要不要多跑一趟。
 * 规则来自常识：需要空腹的项目必须排在进食之前。
 */
export function buildTimeline(department: string, visitTime: string): TimelineTask[] {
  const needsFasting = /内分泌|消化/.test(department);
  const tasks: TimelineTask[] = [];

  let order = 1;
  if (needsFasting) {
    tasks.push({
      order: order++,
      task: '空腹抽血（先做，避免进食影响结果）',
      dependsOn: [],
      note: '前一晚 22 点后禁食，可少量饮水',
    });
  }
  tasks.push({
    order: order++,
    task: '到科室分诊台报到',
    dependsOn: [],
    note: visitTime ? `预约时间 ${visitTime.slice(11, 16)}，建议提前 20 分钟到` : '',
  });
  tasks.push({
    order: order++,
    task: `见${department}医生`,
    dependsOn: needsFasting ? ['空腹抽血'] : [],
    note: '带上既往检查报告与用药清单',
  });
  tasks.push({
    order: order++,
    task: '按医嘱补做检查',
    dependsOn: [`见${department}医生`],
    note: '如有检查，先看是否需要预约、是否当天可出结果',
  });

  return tasks;
}

/* ============================ Agent ============================ */

export interface SchedulerInputPayload {
  text: string;
  /** 会话里已确定的科室（来自分诊），可作为兜底 */
  knownDepartment?: string;
}

export function makeScheduler() {
  async function handle(
    input: AgentInput<SchedulerInputPayload>,
  ): Promise<AgentOutput<SchedulerPayload>> {
    const events: AgentEvent[] = [];
    const intent = parseBookingIntent(input.payload.text);

    /* ---- 抽不到科室：问清楚，不猜 ---- */
    if (!intent && !input.payload.knownDepartment) {
      events.push({
        type: 'clarify',
        question: '你想挂哪个科？如果不确定，可以先把症状告诉我，我帮你判断该挂哪个科。',
        missing: ['科室'],
      });
      return {
        status: 'need_clarify',
        payload: { action: 'query', preview: null, timeline: [] },
        confidence: 0.3,
        evidence: [],
        events,
      };
    }

    const department = intent?.department ?? input.payload.knownDepartment!;
    /*
     * 没提院区时按顺序试：这正是"换院区才有号"的价值。
     *
     * 顺序把浙二放前面：它是样例里唯一有真实名称的三甲，
     * 用户说"帮我挂个号"时给一家可识别的医院比给"演示市第一人民医院"
     * 更像真事。MOCK 两家仍然在后备里，保证都能被搜到。
     */
    const candidates = intent?.hospitalCode
      ? [intent.hospitalCode]
      : ['Z2-JFL', 'MOCK-A', 'MOCK-B'];

    const startDate = intent?.date ?? todayLocal();
    const dates = intent?.date ? [intent.date] : nextDays(startDate, 14);

    /* ---- 逐院区、逐日期找第一个有号的 ---- */
    let found: { slots: SlotDto[]; hospitalCode: string; date: string } | null = null;
    let sawUnreachable = false;

    outer: for (const code of candidates) {
      for (const date of dates) {
        const r = await querySlots(code, department, date);
        if (r.ok) {
          found = { slots: r.slots, hospitalCode: code, date };
          break outer;
        }
        if (r.reason === 'unreachable') {
          // 后端挂了再试也没用，直接停
          sawUnreachable = true;
          break outer;
        }
      }
    }

    /* ---- 后端不可达：如实说，不假装没号 ---- */
    if (!found && sawUnreachable) {
      events.push({
        type: 'caveat',
        text: '号源服务暂时连不上（后端未启动）。\n可以先告诉我症状，我帮你确认该挂哪个科。',
      });
      return {
        status: 'failed',
        payload: { action: 'query', preview: null, timeline: [] },
        confidence: 0,
        evidence: [],
        events,
        degraded: { stage: 'scheduler', reason: 'backend unreachable', fallback: 'message-only' },
      };
    }

    /* ---- 真的没号 ---- */
    if (!found) {
      events.push({
        type: 'caveat',
        text: `${department}在最近两周内没有可预约的号源。可以换个科室，或直接到门诊导诊台咨询加号。`,
      });
      return {
        status: 'ok',
        payload: { action: 'query', preview: null, timeline: [] },
        confidence: 0.5,
        evidence: [],
        events,
      };
    }

    /* ---- 有号：给预览卡 + 时间线 ---- */
    const slot = found.slots[0]!;
    const preview: BookingPreview = {
      // preorderId 用"院区+科室+时间"拼一个可读的占位 id。
      // 真正下单由前端调后端，不需要在 BFF 侧预占号位 ——
      // 预占会让"看预览"这个动作产生副作用。
      preorderId: `${found.hospitalCode}:${department}:${slot.visitTime}`,
      // 下单要用编码（后端按它分发适配器），展示名查不到
      hospitalCode: found.hospitalCode,
      hospital: hospitalName(found.hospitalCode),
      department,
      doctor: slot.doctorName,
      slot: slot.visitTime,
      holdExpiresAt: '',
    };

    events.push({ type: 'booking_preview_card', preorder: preview });

    // 同一科室另一家院区也查一次，用来提示"换院区有/没号"
    /*
     * 顺便查另一家有号的院区，用来演示"换院区也能约"。
     *
     * 原来写死成 MOCK-A ↔ MOCK-B 的二选一，加了第三家后那种写法
     * 会把浙二永远排除在对比之外。改成"在候选列表里取第一个不等于
     * 当前院区的"，加院区时不用再改这里。
     */
    const otherCode = ['Z2-JFL', 'MOCK-A', 'MOCK-B'].find((c) => c !== found.hospitalCode)!;
    const other = await querySlots(otherCode, department, found.date);
    if (other.ok) {
      events.push({
        type: 'caveat',
        text: `${hospitalName(otherCode)}同一天也有号（${other.slots.length} 个时段可选），如需比较可以先看看。`,
      });
    } else if (other.reason === 'no_department') {
      // 别家没这个科室是很正常的信息，不必提示
    }

    const timeline = buildTimeline(department, slot.visitTime);
    events.push({ type: 'timeline_card', tasks: timeline });

    return {
      status: 'ok',
      payload: { action: 'preview_booking', preview, timeline },
      confidence: 0.8,
      evidence: [{ type: 'order', id: preview.preorderId, span: [0, 0] }],
      events,
    };
  }

  return (input: AgentInput<SchedulerInputPayload>) =>
    safeRun(handle, input, {
      agent: 'scheduler',
      timeoutMs: SCHEDULER_TIMEOUT_MS,
      fallback: {
        ...emptyOutput<SchedulerPayload>({ action: 'query', preview: null, timeline: [] }),
        events: [
          {
            type: 'caveat',
            text: '预约服务暂时不可用。可以先告诉我症状，我帮你确认该挂哪个科；或直接到门诊导诊台咨询。',
          },
        ],
      },
    });
}
