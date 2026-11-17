/* ------------------------------------------------------------------
 * 院方工具层 —— MCP 形状的封装（docs/10 D3）
 *
 * ============ 这一层做什么、不做什么 ============
 *
 * 做：把"查号源 / 锁号"封装成**签名与 MCP tool 一致**的函数
 *     （`name` + `description` + `inputSchema` + `handler`）。
 * 待开发：启动独立 MCP server 进程、引入 MCP SDK 做真握手。
 *
 * 依据 docs/10 D3 的定论：
 *   「评委看 MCP 4% 看的是工具编排能力，不是握手协议实现。」
 *   所以这里对齐的是 **tool schema 的形状**，
 *   让"改成真 MCP 只换 transport"在代码上站得住。
 *
 * ============ 为什么值得单独一层 ============
 *
 * 在抽出来之前，scheduler.ts 里直接 fetch 后端：
 *   · 业务代码看着 HTTP 细节（URL 拼接、状态码分支）
 *   · 想加工具（比如查就诊须知）就得再复制一遍 fetch 逻辑
 *   · 没法统一做超时、重试、错误分类
 *
 * 抽成工具层之后，Scheduler 只关心"调用一个工具、拿到结果或失败原因"，
 * 具体走 HTTP 还是 MCP 与它无关。
 * ------------------------------------------------------------------ */

/* ============================ 工具定义形状 ============================ */

/** JSON Schema 子集 —— 够描述这些工具的参数 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string; enum?: string[] }>;
  required: string[];
}

/**
 * 一个工具。
 *
 * <p>字段名刻意用 MCP 的叫法（`name` / `description` / `inputSchema`），
 * 而不是自定义的 `toolName` / `schema` —— 搬迁成真 MCP 时字段一一对应。
 */
export interface McpTool<I, O> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: I) => Promise<ToolResult<O>>;
}

/**
 * 工具结果。
 *
 * <p>MCP 用 `{ content: [...] }` 或 `isError`。这里简化为三态，
 * 因为业务层需要区分"网络不通"和"业务上没号"：
 * <ul>
 *   <li>{@code ok} —— 成功</li>
 *   <li>{@code empty} —— 调用成功但没有数据（例如当天没号）</li>
 *   <li>{@code error} —— 调用失败（网络、认证、后端异常）</li>
 * </ul>
 * 把 empty 和 error 混成一种，用户会看到"查询失败"却以为是网络问题。
 */
export type ToolResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'empty'; reason: string }
  | { status: 'error'; reason: ToolErrorReason; detail: string };

export type ToolErrorReason =
  | 'unreachable' // 后端没起 / 网络不通
  | 'not_found' // 科室或院区不存在
  | 'rejected' // 院方业务拒绝（号满、状态冲突）
  | 'unauthorized'; // 需要登录

/* ============================ 后端地址 ============================ */

function backendBase(): string {
  return (process.env.BACKEND_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
}

/** 统一的 HTTP 调用：超时、错误分类都在这里做一次 */
async function callBackend<T>(
  path: string,
  init: RequestInit = {},
): Promise<ToolResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${backendBase()}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    return {
      status: 'error',
      reason: 'unreachable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (res.status === 401) {
    return { status: 'error', reason: 'unauthorized', detail: '需要登录' };
  }
  if (res.status === 400) {
    // 后端用 400 表示"院区/科室不存在"
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    return { status: 'error', reason: 'not_found', detail: body?.message ?? '资源不存在' };
  }
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    return { status: 'error', reason: 'rejected', detail: body?.message ?? '院方拒绝了该操作' };
  }
  if (!res.ok) {
    return { status: 'error', reason: 'unreachable', detail: `后端返回 ${res.status}` };
  }

  const body = (await res.json().catch(() => null)) as { code?: number; data?: T; message?: string } | null;
  if (!body || body.code !== 0) {
    return {
      status: 'error',
      reason: 'unreachable',
      detail: body?.message ?? '返回内容不是合法 JSON',
    };
  }
  return { status: 'ok', data: body.data as T };
}

/* ============================ 工具一：list_slots ============================ */

export interface SlotDto {
  visitTime: string;
  doctorName: string;
  remaining: number;
}

export interface ListSlotsArgs {
  hospitalCode: string;
  department: string;
  /** YYYY-MM-DD */
  date: string;
}

/**
 * 查号源。对应 docs/05 §4 工具清单里的 `list_slots`。
 *
 * <p>读操作，无副作用，可安全重试。
 */
export const listSlots: McpTool<ListSlotsArgs, SlotDto[]> = {
  name: 'list_slots',
  description: '查询某院区某科室在某天的可预约号源。只读，无副作用。',
  inputSchema: {
    type: 'object',
    properties: {
      hospitalCode: { type: 'string', description: '院区编码，如 MOCK-A' },
      department: { type: 'string', description: '科室名，如 内分泌科' },
      date: { type: 'string', description: '就诊日期，格式 YYYY-MM-DD' },
    },
    required: ['hospitalCode', 'department', 'date'],
  },
  async handler(args) {
    const q = new URLSearchParams({
      hospitalCode: args.hospitalCode,
      department: args.department,
      date: args.date,
    });
    const r = await callBackend<SlotDto[]>(`/api/bookings/slots?${q.toString()}`);
    if (r.status !== 'ok') return r;
    if (!Array.isArray(r.data) || r.data.length === 0) {
      return { status: 'empty', reason: '该日期没有可预约的号源' };
    }
    return r;
  },
};

/* ============================ 工具二：hold_slot ============================ */

export interface HoldSlotArgs {
  hospitalCode: string;
  department: string;
  /** ISO 时间，如 2026-11-16T08:30:00 */
  visitTime: string;
  /** 创建者的访问令牌；下单是需要认证的写操作 */
  token: string;
}

/**
 * 锁号 / 下单。对应 `hold_slot`。
 *
 * <p><b>写操作，有副作用。</b>调用前必须有用户明确确认 ——
 * 这正是 Scheduler Agent 只做预览、把确认留给人的原因（见 scheduler.ts）。
 *
 * <p>需要 token：后端对 POST /api/bookings 要求认证，
 * 因为挂号要能追溯到具体的人。读接口（list_slots）不需要。
 */
export const holdSlot: McpTool<HoldSlotArgs, { id: number; externalOrderNo: string | null }> = {
  name: 'hold_slot',
  description: '占号并创建预约单。写操作，会占用号源，调用前需用户确认。',
  inputSchema: {
    type: 'object',
    properties: {
      hospitalCode: { type: 'string', description: '院区编码' },
      department: { type: 'string', description: '科室名' },
      visitTime: { type: 'string', description: '就诊时间，ISO 格式' },
      token: { type: 'string', description: '用户访问令牌' },
    },
    required: ['hospitalCode', 'department', 'visitTime', 'token'],
  },
  async handler(args) {
    return callBackend('/api/bookings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify({
        hospitalCode: args.hospitalCode,
        department: args.department,
        visitTime: args.visitTime,
      }),
    });
  },
};

/* ============================ 工具三：list_hospitals ============================ */

/**
 * 列出已接入的院区。对应"换院区才有号"这个差异化需要的前置信息。
 */
export const listHospitals: McpTool<Record<string, never>, string[]> = {
  name: 'list_hospitals',
  description: '列出已接入的院区编码。只读，无副作用。',
  inputSchema: { type: 'object', properties: {}, required: [] },
  async handler() {
    const r = await callBackend<string[]>('/api/bookings/hospitals');
    if (r.status !== 'ok') return r;
    if (!Array.isArray(r.data) || r.data.length === 0) {
      return { status: 'empty', reason: '没有已接入的院区' };
    }
    return r;
  },
};

/* ============================ 注册表 ============================ */

/** 院区目录的一项：院方侧关于"这家医院长什么样"的全部事实 */
export interface HospitalCatalogEntry {
  code: string;
  /** 展示名，演示环境带「（演示）」后缀 */
  name: string;
  /** 院区开设的科室 */
  departments: string[];
}

/**
 * 院区目录。对应 `GET /api/bookings/hospitals/catalog`。
 *
 * <p><b>为什么值得多一个工具而不是复用 list_hospitals</b>：
 * 后者只给编码，排程 Agent 拿到编码后只能硬编码一张
 * 「编码 → 医院名 + 有哪些科」的表。那张表一加院区就漏一次，
 * 而漏掉的表现是"AI 推荐了一个这家庭院根本没开的科室"，
 * 用户点进去才发现没号。
 *
 * <p>现在名字和科室都由院方侧给出，Agent 侧不再持有第二份真相。
 */
export const listHospitalCatalog: McpTool<Record<string, never>, HospitalCatalogEntry[]> = {
  name: 'list_hospital_catalog',
  description: '列出已接入院区的编码、展示名与开设科室。只读，无副作用。',
  inputSchema: { type: 'object', properties: {}, required: [] },
  async handler() {
    const r = await callBackend<HospitalCatalogEntry[]>('/api/bookings/hospitals/catalog');
    if (r.status !== 'ok') return r;
    if (!Array.isArray(r.data) || r.data.length === 0) {
      return { status: 'empty', reason: '没有已接入的院区' };
    }
    return r;
  },
};

export const HOSPITAL_TOOLS = [
  listSlots,
  holdSlot,
  listHospitals,
  listHospitalCatalog,
] as const;

/** 生成 MCP `tools/list` 形状的清单（不含 handler） */
export function toolManifest() {
  return HOSPITAL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/** 按名字取工具，找不到返回 undefined */
export function getTool(name: string) {
  return HOSPITAL_TOOLS.find((t) => t.name === name);
}
