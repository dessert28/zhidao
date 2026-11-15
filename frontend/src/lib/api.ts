/* ------------------------------------------------------------------
 * 后端 API 客户端
 *
 * 所有请求走 `/api/backend/*`，由 BFF 转发到 Spring Boot。
 * 前端代码里**不出现 8080** —— 换环境不用改代码（见 backend-proxy.ts 的说明）。
 *
 * 设计要点：
 *
 * 1. **Token 存 sessionStorage 而不是 localStorage**。
 *    关掉标签页就失效，共享电脑上更安全；代价是重开页面要重新登录，
 *    对演示反而是好事（每次从干净状态开始）。
 *
 * 2. **失败一律返回结构化结果，不抛异常**。
 *    界面上「后端没启动」和「没有数据」必须区分开 ——
 *    前者要提示去起后端，后者是正常的空状态。混在一起会让用户
 *    以为系统坏了。
 *
 * 3. **后端不可用不影响 AI 对话**。这是刻意的降级：
 *    病历/提醒读不到，但问诊照样能做。整个页面的核心功能
 *    不该被一个附属接口拖垮。
 * ------------------------------------------------------------------ */

const BASE = '/api/backend';

/* ============================ 类型 ============================ */

/** 后端统一响应体（ApiResult<T>） */
interface ApiResult<T> {
  code: number;
  message: string;
  data: T;
}

/** 后端不可用的原因，供 UI 显示可执行的提示 */
export type BackendFailure =
  | { kind: 'unreachable'; message: string }
  | { kind: 'unauthorized' }
  | { kind: 'disabled'; message: string }
  | { kind: 'error'; message: string };

export type BackendResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: BackendFailure };

export interface MedicalRecord {
  id: number;
  hospitalCode: string;
  visitDate: string;
  department: string | null;
  diagnosisBrief: string | null;
  ocrText: string | null;
  fileName: string | null;
  source: string;
}

export interface ReminderTask {
  id: number;
  refType: string;
  refId: number | null;
  title: string;
  detail: string | null;
  reason: string | null;
  dueAt: string;
  status: string;
}

export interface PatientProfile {
  userId: number;
  birthYear: number | null;
  age: number | null;
  gender: string | null;
  allergies: string[];
  chronics: string[];
  /** 在用的药（跨院处方汇总）。用于「用药冲突提示」，只提示不判断 */
  medications: string[];
}

/**
 * 把档案转成对话用的 SessionFacts。
 *
 * <p>这条转换是「跨院用药冲突提示」的**唯一数据入口**：
 * Reviewer 的 `drugConflictCheck()` 早就在跑了，但因为前端从不传 facts，
 * 它拿到的 `currentMedications` 永远是空数组 —— 函数形同虚设。
 *
 * <p>字段名与 `@shared/types/contract` 的 SessionFacts 对齐，
 * 不在这里改名：多一层映射就多一处可能对不上的地方。
 */
export function toSessionFacts(p: PatientProfile | null): {
  allergies: string[];
  chronicConditions: string[];
  currentMedications: string[];
  bookingState: null;
} {
  return {
    allergies: p?.allergies ?? [],
    chronicConditions: p?.chronics ?? [],
    currentMedications: p?.medications ?? [],
    bookingState: null,
  };
}

export interface BookingOrder {
  id: number;
  hospitalCode: string;
  department: string;
  visitTime: string;
  status: string;
  externalOrderNo: string | null;
  remark: string | null;
}

/* ============================ Token ============================ */

const TOKEN_KEY = 'zhidao:token';

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    // 隐私模式下 sessionStorage 可能不可用，降级为"未登录"
    return null;
  }
}

function setToken(t: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* 存不了就存不了，这次会话内仍能用内存值 */
    memoryToken = t;
  }
}

/** sessionStorage 不可用时的兜底 */
let memoryToken: string | null = null;

export function currentToken(): string | null {
  return getToken() ?? memoryToken;
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  memoryToken = null;
}

/* ============================ 底层请求 ============================ */

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<BackendResult<T>> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  const token = currentToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    // 连 BFF 都失败，说明 dev server 自己挂了
    return { ok: false, failure: { kind: 'unreachable', message: '前端服务未响应。' } };
  }

  // 503 是 BFF 明确告知"后端不可达"或"后端未启用"
  if (res.status === 503) {
    const body = await safeJson<{ error?: string; message?: string }>(res);
    return {
      ok: false,
      failure: {
        kind: body?.error === 'backend_disabled' ? 'disabled' : 'unreachable',
        message: body?.message ?? '后端不可用。',
      },
    };
  }

  if (res.status === 401) {
    clearToken();
    return { ok: false, failure: { kind: 'unauthorized' } };
  }

  if (!res.ok) {
    const body = await safeJson<{ message?: string }>(res);
    return {
      ok: false,
      failure: { kind: 'error', message: body?.message ?? `请求失败（${res.status}）` },
    };
  }

  const body = await safeJson<ApiResult<T>>(res);
  if (!body) {
    return { ok: false, failure: { kind: 'error', message: '返回内容不是合法 JSON。' } };
  }
  if (body.code !== 0) {
    return { ok: false, failure: { kind: 'error', message: body.message || '业务处理失败。' } };
  }
  return { ok: true, data: body.data };
}

async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* ============================ 业务接口 ============================ */

/**
 * 登录并保存 token。
 *
 * <p>演示账号 demo / demo1234 是种子数据，不是密钥 —— 它就写在
 * README 与 data.sql 注释里，目的是让评委不用注册就能看功能。
 */
export async function login(
  username = 'demo',
  password = 'demo1234',
): Promise<BackendResult<{ token: string; username: string }>> {
  const r = await request<{ token: string; username: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (r.ok) setToken(r.data.token);
  return r;
}

/** 确保已登录：没有 token 就自动用演示账号登一次 */
/**
 * 进行中的登录请求。多个组件同时挂载时共享同一个 Promise，
 * 而不是各发一次 —— 实测首页会同时挂 ChatPage 与 usePatientFacts，
 * 没有这一层时 /api/auth/login 一毫秒内连发两次。
 */
let pendingLogin: Promise<BackendResult<true>> | null = null;

export async function ensureLogin(): Promise<BackendResult<true>> {
  if (currentToken()) return { ok: true, data: true };
  pendingLogin ??= (async () => {
    const r = await login();
    return r.ok ? { ok: true, data: true } : { ok: false, failure: r.failure };
  })();
  try {
    return await pendingLogin;
  } finally {
    pendingLogin = null;
  }
}

export function getRecords() {
  return request<{ total: number; records: MedicalRecord[] }>('/api/patient/records');
}

/**
 * 提交一份就诊记录的**脱敏摘要**。
 *
 * <p>注意 `ocrText` 这个字段名来自后端 schema，但它装的是
 * `redact()` 之后的文本 —— 原文只在浏览器 IndexedDB 里。
 * 调用方（lib/db/upload.ts）负责保证这个顺序。
 *
 * <p>当前后端还没有这个写接口（PatientController 只提供了 GET），
 * 所以这里先按契约写好，等后端补 POST 即可生效。
 */
export function createRecord(input: {
  hospitalCode: string;
  visitDate: string;
  department: string | null;
  diagnosisBrief: string;
  ocrText: string;
  fileName: string;
  fileSize: number;
}) {
  return request<MedicalRecord>('/api/patient/records', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getProfile() {
  return request<PatientProfile>('/api/patient/profile');
}

export function getReminders() {
  return request<ReminderTask[]>('/api/reminders');
}

export function markReminder(id: number, action: 'done' | 'skip') {
  return request<ReminderTask>(`/api/reminders/${id}/${action}`, { method: 'POST' });
}

/* ============================ 院内导航 ============================ */

/** 一个院内地点（后端 hospital_place 的投影） */
export interface NavPlace {
  placeType: string;
  department: string | null;
  name: string;
  building: string | null;
  floor: string | null;
  directions: string | null;
  openHours: string | null;
  estMinutes: number | null;
  dataQuality: 'REAL' | 'SAMPLE';
}

/** 路线中的一步 */
export interface NavStep {
  order: number;
  stage: string;
  stageLabel: string;
  place: NavPlace;
  /** DONE 已完成 / CURRENT 现在去 / UPCOMING 待办 */
  status: 'DONE' | 'CURRENT' | 'UPCOMING';
  note: string;
}

export interface NavRoute {
  hospitalCode: string;
  department: string;
  steps: NavStep[];
  totalMinutes: number;
  /**
   * 数据可信度。SAMPLE 表示示意数据 —— 界面必须标出来，
   * 不能让患者把编的楼层当成真实导航。
   */
  dataQuality: 'REAL' | 'SAMPLE';
  visitTime: string;
}

/**
 * 取院内路线。
 *
 * <p>不需要登录：患者站在楼里找不着路时，不该先被要求登录。
 */
export function getNavRoute(input: {
  hospitalCode: string;
  department: string;
  needsFasting?: boolean;
  visitTime: string;
}) {
  const q = new URLSearchParams({
    hospitalCode: input.hospitalCode,
    department: input.department,
    needsFasting: String(input.needsFasting ?? false),
    visitTime: input.visitTime,
  });
  return request<NavRoute>(`/api/nav/route?${q.toString()}`);
}

/** 现在该去哪一步 */
export function getCurrentStep(input: {
  hospitalCode: string;
  department: string;
  needsFasting?: boolean;
  visitTime: string;
}) {
  const q = new URLSearchParams({
    hospitalCode: input.hospitalCode,
    department: input.department,
    needsFasting: String(input.needsFasting ?? false),
    visitTime: input.visitTime,
  });
  return request<{
    hasStep: boolean;
    step?: NavStep;
    message?: string;
    maybeClosed?: boolean;
  }>(`/api/nav/current?${q.toString()}`);
}

/** 排队估算结果 */
export interface QueueEstimate {
  aheadCount: number;
  waitMinutes: number;
  reasonable: boolean;
  /** HIGH / MEDIUM / LOW —— LOW 时说明"这次估算不可靠" */
  confidence: string;
  /** 为什么是这个结果 */
  reason: string;
  /** 现在该做什么 */
  advice: string;
  /** 必须一起展示：这是估算不是院方实时叫号 */
  disclaimer: string;
}

export interface QueueInfo {
  orderId: number;
  hospitalCode: string;
  department: string;
  visitTime: string;
  status: string;
  estimate: QueueEstimate;
  /** 该科室单人的平均耗时，让患者理解数字怎么来的 */
  minutesPerPatient: number;
  now: string;
}

/**
 * 查某张预约单的排队估算。
 *
 * <p>需要登录（这是"我的某一单"的信息）。
 */
export function getQueueEstimate(orderId: number) {
  return request<QueueInfo>(`/api/bookings/${orderId}/queue`);
}

export function getBookings() {
  return request<BookingOrder[]>('/api/bookings');
}

/**
 * 创建预约单。
 *
 * <p>这是整个前端唯一一个**有真实副作用**的写操作：
 * 占号、影响别人、写进数据库。所以它只由用户点击「确认挂号」触发，
 * 绝不由 AI 自动调用 —— 见 scheduler.ts 的边界说明。
 */
export function createBooking(input: {
  hospitalCode: string;
  department: string;
  visitTime: string;
  remark?: string;
}) {
  return request<BookingOrder>('/api/bookings', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/* ============================ 展示辅助 ============================ */

/** 院区编码 → 展示名。后端只存 code，名字在海报里没意义但界面上要有 */
export function hospitalName(code: string): string {
  const map: Record<string, string> = {
    'MOCK-A': '演示市第一人民医院',
    'MOCK-B': '演示市中心医院',
    // 少这一行时，病历页的预约列表会直接显示 "Z2-JFL" 这种内部编码，
    // 患者看不懂。实测发现后补上 —— 院区展示名必须在前后端都覆盖。
    'Z2-JFL': '浙大二院（解放路院区）',
  };
  return map[code] ?? code;
}

/** ISO 时间 → 「11月2日」这种短格式 */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
