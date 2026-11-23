/* ------------------------------------------------------------------
 * 后端 API 客户端
 *
 * 大作业分支：BFF 已下线，所有业务请求直连 Spring Boot。
 * dev 由 Vite proxy 转发，prod 由 Spring Boot 同源托管静态产物。
 * 前端代码里**不出现 8080** —— 换环境不用改代码。
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

/*
 * BFF 下线后直连后端：dev 期 Vite 把 /api/* 代理到 8080，
 * prod 期 Spring Boot 与前端同源。BASE 留空即可，路径本身就是 /api/xxx。
 */
const BASE = '';

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

/** 把失败原因转成可展示的话。unauthorized 分支没有 message，不能直接用 r.failure.message */
export function failureMessage(f: BackendFailure): string {
  if (f.kind === 'unauthorized') return '登录已失效，请重新登录';
  return f.message;
}

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
  /**
   * 健康档案的一句话摘要（年龄、慢病、在用的药），供对话时带给模型。
   *
   * <p>为什么放在 facts 里而不是单独传：它本来就属于"患者事实"，
   * 多开一个通道只会让调用方多记一个参数。空字符串表示没有档案。
   */
  healthText: string;
} {
  const parts: string[] = [];
  if (p?.age != null) parts.push(`${p.age} 岁`);
  if (p?.chronics?.length) parts.push(`慢病：${p.chronics.join('、')}`);
  if (p?.allergies?.length) parts.push(`过敏：${p.allergies.join('、')}`);
  if (p?.medications?.length) parts.push(`在用药：${p.medications.join('、')}`);

  return {
    allergies: p?.allergies ?? [],
    chronicConditions: p?.chronics ?? [],
    currentMedications: p?.medications ?? [],
    bookingState: null,
    healthText: parts.join('；'),
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
  /**
   * 自助签到时间（ISO）。null 表示还没签到。
   *
   * <p>注意它是**本地签到**：只表示患者在自己手机上点了"我已到院"，
   * 不代表院方系统里已经报到。改名成 checkedIn 会丢掉这层语义。
   */
  checkinAt?: string | null;
}

/* ============================ Token ============================ */

const TOKEN_KEY = 'zhidao:token';

/**
 * 用户主动退出标记。
 *
 * <p>为什么不能只删 token：项目里有 {@link ensureLogin}，各页面拿不到数据
 * 就会用演示账号自动登一次。只删 token 的话，退出后跳回首页的瞬间就被
 * 悄悄登回去了 —— 用户会以为"退出"按钮是坏的。
 *
 * <p>这个标记表达的是"用户明确选择不登录"，只有再次登录/注册，或显式点
 * 登录页的「先逛逛」才会清除。放在 sessionStorage：关掉标签页后标记消失，
 * 下次打开仍是熟悉的自动登录体验。
 */
const SIGNED_OUT_KEY = 'zhidao:signed-out';

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

/** 是否为「用户主动退出」状态。主应用外壳据此把人送回登录页。 */
export function isSignedOut(): boolean {
  try {
    return sessionStorage.getItem(SIGNED_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

/** 登录/注册成功，或用户选择「先逛逛」时，解除退出状态 */
export function clearSignedOut(): void {
  try {
    sessionStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 退出登录：丢弃 token，并阻止 ensureLogin 自动把人登回去。
 *
 * <p>后端 JWT 是无状态的，服务端没有会话可注销 —— 所以这里的工作就是
 * 丢弃客户端凭证。token 只存于本次会话，关标签页即失效。
 */
export function logout(): void {
  clearToken();
  // 角色也要清掉：不清的话，管理员退出后用患者账号登录，
  // 顶栏仍按 ADMIN 渲染，点进去只会收获一串 403
  try {
    sessionStorage.removeItem(ROLE_KEY);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.setItem(SIGNED_OUT_KEY, '1');
  } catch {
    /* ignore */
  }
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
export interface AuthPayload {
  token: string;
  userId: number;
  username: string;
  role: string;
  /** 秒。客户端时钟不可信，由它换算倒计时 */
  expiresIn: number;
}

export async function login(
  username = 'demo',
  password = 'demo1234',
): Promise<BackendResult<AuthPayload>> {
  const r = await request<AuthPayload>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (r.ok) {
    setToken(r.data.token);
    setRole(r.data.role);
    clearSignedOut();
  }
  return r;
}

/**
 * 注册。手机号即登录名，后端注册成功后直接签发 token —— 注册即登录，
 * 前端拿到 token 后就不用再跳一次登录页。
 */
export async function register(
  name: string,
  phone: string,
  password: string,
): Promise<BackendResult<AuthPayload>> {
  const r = await request<AuthPayload>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, phone, password, agreed: true }),
  });
  if (r.ok) {
    setToken(r.data.token);
    setRole(r.data.role ?? 'PATIENT');
    clearSignedOut();
  }
  return r;
}

/* ============================ 协议 ============================ */

export interface AgreementLinkData {
  id: 'terms' | 'privacy';
  label: string;
  href: string;
}

export interface AgreementDocumentData {
  id: 'terms' | 'privacy';
  title: string;
  updatedAt: string;
  sections: Array<{ heading: string; body: string }>;
}

/** 协议链接列表（公开接口，未登录可读） */
export function getAgreementLinks() {
  return request<AgreementLinkData[]>('/api/agreements');
}

/** 协议正文（公开接口） */
export function getAgreementDocument(id: 'terms' | 'privacy') {
  return request<AgreementDocumentData>(`/api/agreements/${id}`);
}

/** 确保已登录：没有 token 就自动用演示账号登一次 */
/**
 * 进行中的登录请求。多个组件同时挂载时共享同一个 Promise，
 * 而不是各发一次 —— 实测首页会同时挂 ChatPage 与 usePatientFacts，
 * 没有这一层时 /api/auth/login 一毫秒内连发两次。
 */
let pendingLogin: Promise<BackendResult<true>> | null = null;

export async function ensureLogin(): Promise<BackendResult<true>> {
  // 用户主动退出后不能再自动登回去，否则「退出」按钮等于没生效
  if (isSignedOut()) return { ok: false, failure: { kind: 'unauthorized' } };
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

/* ============================ 问诊会话历史 ============================ */

/**
 * 一条持久化的问诊消息。
 *
 * <p>字段名与后端 `ChatHistoryItem` 逐字对齐，这里不改名：
 * 改名就要再维护一层映射，而映射写错的代价是「历史还原顺序乱了」——
 * 这种 bug 在本地永远复现不了（要刷新一次才看得见）。
 *
 * <p>`createdAt` 不参与还原逻辑，只留给未来「按日期分组」用：
 * 顺序以后端返回的数组为准（约定是时间正序），而不是前端再排一次。
 */
export interface ChatHistoryItem {
  id: number | string;
  role: 'user' | 'assistant';
  content: string;
  /** 同一轮问答的用户消息与回复共享这个 id，还原时靠它配对 */
  turnId: string;
  createdAt: string;
}

/**
 * 拉一次会话历史。不传 `sessionId` 时后端返回「该用户最近一次会话」。
 *
 * <p><b>调用方必须容忍失败</b>：后端没启动时这里是 `ok: false`，
 * 而问诊对话本身走的是 `/api/chat`（另一条链路），不该被历史接口拖垮。
 * 见 useEventStream 里的静默降级。
 */
export function getChatHistory(sessionId?: string) {
  const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  return request<ChatHistoryItem[]>(`/api/chat-history${q}`);
}

/**
 * 清空某个会话的后端历史。
 *
 * <p>只在用户主动点「重来」时调用 —— 它删的是服务端数据，
 * 不该由任何自动流程触发。
 */
export function clearChatHistory(sessionId: string) {
  return request<null>(`/api/chat-history/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
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
  /**
   * 状态。
   *
   * <p>DONE / CURRENT / UPCOMING 由后端按时间推算；
   * **SKIPPED 只可能来自患者手动标记**（"这一步我不需要做"）。
   * 界面必须把两者分开显示 —— 把 SKIPPED 显示成"已完成"
   * 会让患者回看时以为那项检查做过。
   */
  status: 'DONE' | 'SKIPPED' | 'CURRENT' | 'UPCOMING';
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
  /**
   * 带上它，后端会把该单的手动进度叠加到时间推算上。
   *
   * <p>不带就是纯时间推算 —— 匿名访问依然可用，这也是这个接口
   * 不需要登录的原因：拿不到任何人的进度。
   */
  bookingId?: number;
}) {
  const q = new URLSearchParams({
    hospitalCode: input.hospitalCode,
    department: input.department,
    needsFasting: String(input.needsFasting ?? false),
    visitTime: input.visitTime,
  });
  if (input.bookingId != null) q.set('bookingId', String(input.bookingId));
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

/** 患者查看自己的院方调阅记录 */
export interface AccessLogItem {
  id: number;
  hospitalCode: string;
  /** VIEW_REPORT_DETAIL / ARCHIVED / DENIED */
  action: string;
  visitDate: string | null;
  itemCount: number;
  archived: boolean;
  createdAt: string | null;
}

/** 患者与某院区的匹配码 */
export interface BindingItem {
  matchCode: string;
  hospitalCode: string;
  createdAt: string | null;
}

export function getAccessLog() {
  return request<AccessLogItem[]>('/api/his/my-access-log');
}

export function listBindings() {
  return request<BindingItem[]>('/api/his/binding');
}

export function createBinding(hospitalCode: string) {
  return request<{ matchCode: string; hospitalCode: string; hint: string }>(
    `/api/his/binding?hospitalCode=${encodeURIComponent(hospitalCode)}`,
    { method: 'POST' },
  );
}

export function getAutoGrant() {
  return request<{ autoGrant: boolean }>('/api/his/auto-grant');
}

export function setAutoGrant(enabled: boolean) {
  return request<{ autoGrant: boolean }>(`/api/his/auto-grant?enabled=${enabled}`, {
    method: 'POST',
  });
}

export function getBookings() {
  return request<BookingOrder[]>('/api/bookings');
}

/* ============================ 退号 ============================ */

/** 退号政策查询结果 */
export interface CancelPolicy {
  canCancel: boolean;
  /** 不能退时给患者看的原因；能退时为 null */
  reason: string | null;
  /** 自助退号的截止时间点 */
  deadline: string | null;
}

/**
 * 问后端"这个号还能不能退"。
 *
 * <p>为什么不让前端自己算 24 小时：规则一变前端就得跟着改。
 * 而且不同院区政策不同，前端没有那份知识 ——
 * 它只负责把后端的话显示出来。
 */
export function getCancelPolicy(orderId: number) {
  return request<CancelPolicy>(`/api/bookings/${orderId}/cancel-policy`);
}

/**
 * 退号。
 *
 * <p>失败时后端会给出具体原因（"距就诊不足 24 小时，请到窗口办理"），
 * 已经透传在 {@code failure.message} 里 —— 前端不要再包装成
 * "取消失败"这种没有信息量的话。
 */
export function cancelBooking(orderId: number) {
  return request<BookingOrder>(`/api/bookings/${orderId}/cancel`, { method: 'POST' });
}

/* ============================ 签到 ============================ */

/**
 * 自助签到「我已到院」。
 *
 * <p><b>它只在我们自己的库里记一个时间点</b>，不调用院方系统，
 * 也不代表院方那边已经报到 —— 真正的签到仍要在自助机或分诊台完成。
 * 界面上必须把这句写出来，否则患者会以为点一下就不用去机器上刷，
 * 到诊室才发现没报到。
 *
 * <p>后端幂等：重复调用只记第一次的时间。
 */
export function checkInBooking(orderId: number) {
  return request<BookingOrder>(`/api/bookings/${orderId}/checkin`, { method: 'POST' });
}

/* ============================ 流程进度 ============================ */

/** 某一步的状态：患者标记的 DONE / SKIPPED，或路线原生的 CURRENT / UPCOMING */
export type StepState = 'DONE' | 'SKIPPED' | 'CURRENT' | 'UPCOMING';

/**
 * 读某张预约单的手动进度。
 *
 * @returns navKey → state。没标的步骤不在这个 map 里，
 *          前端按路线原生的状态显示。
 */
export function getVisitProgress(bookingId: number) {
  return request<Record<string, StepState>>(`/api/bookings/${bookingId}/progress`);
}

/**
 * 标记某一步。
 *
 * <p>state 传空串表示**清除**这一步的标记 —— 患者发现自己标错了，
 * 或者想回到系统的默认推算。刻意不设单独的"取消"接口：
 * 同一个动作的正反两向放在一个方法里，前后端都不会漏掉一条路径。
 */
export function markVisitStep(bookingId: number, navKey: string, state: StepState | '') {
  return request<{ progress: Record<string, StepState>; bookingId: number }>(
    `/api/bookings/${bookingId}/progress`,
    {
      method: 'POST',
      body: JSON.stringify({ navKey, state }),
    },
  );
}

/**
 * 生成步骤的稳定标识。
 *
 * <p><b>必须与后端 NavController.navKeyOf 完全一致</b>：
 * 有科室的用 `阶段:科室`，没科室的只用阶段编码。
 * 两边规则不一致的话，患者标记了却不生效 —— 而这个 bug
 * 表现成"点了没反应"，极难查。
 */
export function navKeyOf(step: { stage: string; place: { department?: string | null } }): string {
  const dept = step.place.department;
  return dept && dept.trim() ? `${step.stage}:${dept}` : step.stage;
}

/* ============================ 号源查询 ============================ */

/** 一个可预约时段 */
export interface SlotItem {
  /** ISO 时间，如 2026-11-17T08:30:00 */
  visitTime: string;
  doctorName: string;
  /** 剩余号数。后端已扣掉本地已预约的数量，0 表示满了 */
  remaining: number;
}

/**
 * 查某院区某科室某天的号源。日期格式 YYYY-MM-DD。
 *
 * <p><b>不需要登录</b>：号源是公开信息，大厅屏上就挂着。
 * 挂号页因此能在未登录时就把"有没有号"显示出来，
 * 点确认时才要求身份 —— 让患者先看到号，再决定要不要登录。
 */
export function getSlots(input: {
  hospitalCode: string;
  department: string;
  date: string;
}) {
  const q = new URLSearchParams({
    hospitalCode: input.hospitalCode,
    department: input.department,
    date: input.date,
  });
  return request<SlotItem[]>(`/api/bookings/slots?${q.toString()}`);
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

/** 院区目录的一项，来自 `GET /api/bookings/hospitals/catalog` */
export interface HospitalCatalogEntry {
  code: string;
  name: string;
  departments: string[];
}

/**
 * 院区展示名。
 *
 * <p><b>它曾经是一张硬编码的表</b>（MOCK-A/MOCK-B/Z2-JFL 三行），
 * 而且已经出过一次事故：加了浙二却忘了加这一行，病历页的预约列表
 * 直接显示 "Z2-JFL"，患者看不懂。
 *
 * <p>现在名字由后端院方目录给出（`HospitalAdapter.displayName()`），
 * 前端只缓存一份。加院区只改后端注册表一行，这里自动跟上。
 *
 * <p>拿不到目录时回退到编码本身 —— 显示 "Z2-JFL" 很糟，但比
 * 显示一个猜出来的医院名要好：猜错了，用户会走到错误的地方。
 */
const hospitalNames = new Map<string, string>();

export function rememberHospitalCatalog(list: readonly HospitalCatalogEntry[]): void {
  for (const h of list) hospitalNames.set(h.code, h.name);
}

export function hospitalName(code: string): string {
  return hospitalNames.get(code) ?? code;
}

/** 拉一次院区目录并记住。调用失败不抛：展示名降级为编码，其他功能不受影响 */
export async function loadHospitalCatalog() {
  const r = await request<HospitalCatalogEntry[]>('/api/bookings/hospitals/catalog');
  if (r.ok) rememberHospitalCatalog(r.data);
  return r;
}

/** ISO 时间 → 「11月2日」这种短格式 */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/* ================================================================
 * 角色
 *
 * 后端 JWT 里带 role 声明，登录响应也把它一起给前端。这里存一份，
 * 只用于**决定显示哪个入口**（管理员登录后落到后台、医生落到工作台）。
 *
 * 为什么这不算「前端做权限控制」：它只影响导航，不构成安全边界。
 * 真正的边界在 SecurityConfig 的 hasRole("ADMIN")，
 * 前端即使被改也打不到接口。这一层存在的唯一理由是
 * 「管理员登录后不该先看到患者首页再自己去找后台」。
 * ================================================================ */

const ROLE_KEY = 'zhidao:role';

function setRole(role: string): void {
  try {
    sessionStorage.setItem(ROLE_KEY, role);
  } catch {
    /* 隐私模式下存不了，降级成 PATIENT：少个入口，不会多权限 */
  }
}

/** 当前角色。读不到时按 PATIENT 处理 —— 默认值必须是权限最小的那个 */
export function currentRole(): string {
  try {
    return sessionStorage.getItem(ROLE_KEY) ?? 'PATIENT';
  } catch {
    return 'PATIENT';
  }
}

/** 角色 → 中文名。未知角色原样返回，便于发现后端新增了角色而前端没跟上 */
export function roleLabel(role: string): string {
  if (role === 'ADMIN') return '管理员';
  if (role === 'DOCTOR') return '医生';
  if (role === 'PATIENT') return '患者';
  return role;
}

/* ================================================================
 * 管理端 / 医生端
 *
 * 这两组接口与患者端**共用同一个 request()**，token 走同一处。
 * 不另开一套客户端的原因：一旦分成两套，超时、401 处理、
 * 后端不可达的提示就会慢慢分叉，最后变成两套不同的错误话术。
 * ================================================================ */

/** 分页结构，与后端 common/PageResult 对齐 */
export interface PageData<T> {
  records: T[];
  total: number;
  page: number;
  size: number;
}

export interface AdminUser {
  id: number;
  username: string;
  displayName?: string | null;
  role: string;
  enabled: boolean;
  createdAt?: string | null;
}

export interface AdminHospital {
  hospitalCode: string;
  name: string;
  level?: string | null;
  city?: string | null;
  adapterType?: string | null;
  enabled: boolean;
  /** 院内地点数。列表页用它说明「这个院区配了几条导航」 */
  placeCount?: number;
}

export interface AdminPlace {
  id: number;
  hospitalCode?: string;
  placeType: string;
  department?: string | null;
  name: string;
  building?: string | null;
  floor?: string | null;
  directions?: string | null;
  openHours?: string | null;
  estMinutes?: number | null;
  sortOrder?: number | null;
  dataQuality?: string | null;
}

export interface AdminStatsOverview {
  userCount: number;
  patientCount: number;
  doctorCount: number;
  adminCount: number;
  hospitalCount: number;
  placeCount: number;
  bookingCount: number;
  recordCount: number;
  noticeCount: number;
  todayBookingCount: number;
}

export interface StatPoint {
  name: string;
  value: number;
}

export interface TrendPoint {
  date: string;
  count: number;
}

export interface Notice {
  id: number;
  title: string;
  content: string;
  /** INFO / WARN / URGENT，决定患者端公告条的强调色 */
  level: string;
  pinned: boolean;
  /** PUBLISHED / DRAFT */
  status: string;
  publishedAt?: string | null;
  createdAt?: string | null;
}

/* ---------------- 用户管理 ---------------- */

export function listAdminUsers(params: {
  keyword?: string;
  role?: string;
  page?: number;
  size?: number;
} = {}) {
  const q = new URLSearchParams();
  if (params.keyword) q.set('keyword', params.keyword);
  if (params.role) q.set('role', params.role);
  q.set('page', String(params.page ?? 1));
  q.set('size', String(params.size ?? 20));
  return request<PageData<AdminUser>>(`/api/admin/users?${q.toString()}`);
}

export function createAdminUser(input: {
  username: string;
  displayName?: string;
  password: string;
  role: string;
}) {
  return request<{ id: number }>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateAdminUser(
  id: number,
  patch: { role?: string; enabled?: boolean; displayName?: string },
) {
  return request<null>(`/api/admin/users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteAdminUser(id: number) {
  return request<null>(`/api/admin/users/${id}`, { method: 'DELETE' });
}

/* ---------------- 院区 / 科室 ---------------- */

export function listAdminHospitals(params: { keyword?: string; page?: number; size?: number } = {}) {
  const q = new URLSearchParams();
  if (params.keyword) q.set('keyword', params.keyword);
  q.set('page', String(params.page ?? 1));
  q.set('size', String(params.size ?? 20));
  return request<PageData<AdminHospital>>(`/api/admin/hospitals?${q.toString()}`);
}

export function saveAdminHospital(input: AdminHospital, isNew: boolean) {
  return isNew
    ? request<null>('/api/admin/hospitals', { method: 'POST', body: JSON.stringify(input) })
    : request<null>(`/api/admin/hospitals/${encodeURIComponent(input.hospitalCode)}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      });
}

export function deleteAdminHospital(code: string) {
  return request<null>(`/api/admin/hospitals/${encodeURIComponent(code)}`, { method: 'DELETE' });
}

export function listPlaces(code: string) {
  return request<AdminPlace[]>(`/api/admin/hospitals/${encodeURIComponent(code)}/places`);
}

export function createPlace(code: string, input: Omit<AdminPlace, 'id'>) {
  return request<{ id: number }>(`/api/admin/hospitals/${encodeURIComponent(code)}/places`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function deletePlace(id: number) {
  return request<null>(`/api/admin/places/${id}`, { method: 'DELETE' });
}

/* ---------------- 统计 ---------------- */

/**
 * 统计接口的院区参数。
 *
 * <p>空值一律**不拼参数**，而不是拼 `?hospitalCode=`：后端虽然会把空串
 * 归一成全院，但少发一个参数能少一条"空串到底算不算筛选"的歧义。
 */
function scopeQuery(hospitalCode?: string): string {
  return hospitalCode ? `?hospitalCode=${encodeURIComponent(hospitalCode)}` : '';
}

/** 概览。hospitalCode 省略 = 全部院区汇总 */
export function getAdminOverview(hospitalCode?: string) {
  return request<AdminStatsOverview>(`/api/admin/stats/overview${scopeQuery(hospitalCode)}`);
}

export function getBookingTrend(days = 14, hospitalCode?: string) {
  const scope = hospitalCode ? `&hospitalCode=${encodeURIComponent(hospitalCode)}` : '';
  return request<TrendPoint[]>(`/api/admin/stats/bookings-trend?days=${days}${scope}`);
}

export function getDepartmentStats(hospitalCode?: string) {
  return request<StatPoint[]>(`/api/admin/stats/departments${scopeQuery(hospitalCode)}`);
}

/**
 * 角色分布不接受院区参数：`sys_user` 没有院区字段，管理员/医生不归属院区。
 * 传了也是全院数字，所以干脆不提供这个入口，避免前端误以为筛选生效。
 */
export function getRoleStats() {
  return request<StatPoint[]>('/api/admin/stats/roles');
}

/* ---------------- 公告 ---------------- */

export function listAdminNotices(params: { page?: number; size?: number } = {}) {
  const q = new URLSearchParams();
  q.set('page', String(params.page ?? 1));
  q.set('size', String(params.size ?? 20));
  return request<PageData<Notice>>(`/api/admin/notices?${q.toString()}`);
}

export function saveAdminNotice(input: Omit<Notice, 'id' | 'createdAt' | 'publishedAt'>, id?: number) {
  return id
    ? request<null>(`/api/admin/notices/${id}`, { method: 'PUT', body: JSON.stringify(input) })
    : request<null>('/api/admin/notices', { method: 'POST', body: JSON.stringify(input) });
}

export function deleteAdminNotice(id: number) {
  return request<null>(`/api/admin/notices/${id}`, { method: 'DELETE' });
}

/** 患者端：已发布公告（首页公告条用）。拉不到就当没有公告，不阻塞首页 */
export function getNotices(limit = 3) {
  return request<Notice[]>(`/api/notices?limit=${limit}`);
}

/* ---------------- 医生工作台 ---------------- */

export interface DoctorPatientRow {
  userId: number;
  displayName?: string | null;
  gender?: string | null;
  age?: number | null;
  allergies: string[];
  chronics: string[];
  medications: string[];
  recordCount: number;
  bookingCount: number;
  lastVisitDate?: string | null;
}

export interface DoctorPatientDetail extends DoctorPatientRow {
  records: Array<{
    id: number;
    visitDate: string;
    hospitalCode: string;
    department?: string | null;
    diagnosisBrief?: string | null;
  }>;
  bookings: Array<{
    id: number;
    visitTime: string;
    department?: string | null;
    status: string;
  }>;
}

export function listDoctorPatients(params: { keyword?: string; page?: number; size?: number } = {}) {
  const q = new URLSearchParams();
  if (params.keyword) q.set('keyword', params.keyword);
  q.set('page', String(params.page ?? 1));
  q.set('size', String(params.size ?? 20));
  return request<PageData<DoctorPatientRow>>(`/api/doctor/patients?${q.toString()}`);
}

export function getDoctorPatientDetail(userId: number) {
  return request<DoctorPatientDetail>(`/api/doctor/patients/${userId}`);
}
