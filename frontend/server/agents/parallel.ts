/* ------------------------------------------------------------------
 * multi 的并行执行内核
 *
 * ============ 为什么单独一个模块 ============
 * 这段逻辑决定"两条链路怎么并发、事件怎么缓冲"，一旦出错，
 * 表现是两种都很难查的 bug：
 *   · 没真并发 → 用户多等一次模型往返（5–8 秒），但看不出来哪里错
 *   · 事件串流 → 两条回答的 token 交错，正文变成两个人抢话
 *
 * 放在路由闭包里，只能靠起服务、配 Key、发请求来验，成本太高。
 * 抽成纯函数后，"是否并发"和"缓冲区是否隔离"都能用毫秒级单测钉死。
 *
 * ============ 只做并行，不做分发 ============
 * 这里不判断"该跑哪条链路"（那是 resolveMultiPlan 的事），
 * 也不决定"何时下发"（下发顺序由调用方定，避免把 UI 语义
 * 压进一个通用工具里）。
 * ------------------------------------------------------------------ */

/** 一条可并行的链路 */
export interface ParallelBranch<E> {
  /** 缓冲区标识。同名分支会写进同一个 buffer */
  key: string;
  /** 执行体。事件写入传入的 sink，而不是直接发出去 */
  run: (sink: (e: E) => void) => Promise<unknown>;
}

export interface ParallelOutcome<E> {
  /** key → 该链路产出的事件，按产出顺序保存 */
  buffers: Map<string, E[]>;
  /** 与 branches 一一对应的返回值，供调用方判断 blocked 等状态 */
  results: unknown[];
}

/**
 * 并发执行所有分支，各自事件先缓冲，不直接下发。
 *
 * <p><b>为什么必须缓冲</b>：前端是 append 式渲染 —— 收到一个 token
 * 就往正文后面接。两条链路同时 emit，到达顺序不确定，
 * 用户就会看到「建议挂消化内科，空腹血糖升高要注意……」这种
 * 前半句是分诊、后半句是科普的混合文本。
 *
 * <p>缓冲之后，调用方按固定顺序 flush，顺序就完全可预期。
 *
 * <p>失败语义：任一分支抛错，Promise.all 直接拒绝 —— 由上层
 * 的 toSseStream 兜成 caveat。这是刻意的：链路内部各自有
 * safeRun 降级，能走到这里抛出来的，都是"连降级都没兜住"的
 * 异常，不该被安静吞掉。
 */
export async function collectParallel<E>(
  branches: readonly ParallelBranch<E>[],
): Promise<ParallelOutcome<E>> {
  const buffers = new Map<string, E[]>();
  for (const b of branches) {
    // 预置空数组：调用方即使只 flush 一部分，也不会拿到 undefined
    if (!buffers.has(b.key)) buffers.set(b.key, []);
  }

  const results = await Promise.all(
    branches.map((b) =>
      b.run((e) => {
        // 已在上方预置过，这里必然存在
        buffers.get(b.key)!.push(e);
      }),
    ),
  );

  return { buffers, results };
}
