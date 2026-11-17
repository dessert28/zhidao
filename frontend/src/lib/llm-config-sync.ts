/* ------------------------------------------------------------------
 * 启动时同步模型配置 —— 「刷新页面后配置还在」
 *
 * ============ 为什么需要这一步 ============
 *
 * 用户选的存储位置是浏览器 localStorage，而服务端只把配置放在
 * **进程内存**里。这意味着：
 *
 *   · 用户填完 → 保存 → 前后端都有 → 能用
 *   · 浏览器刷新 → 服务端内存还在 → 还能用
 *   · **服务重启 → 服务端内存清空 → 用户以为配置丢了**
 *
 * 最后一种是最糟的：用户明明看到浏览器里还留着 Key，
 * 但系统却退回规则路由，没有任何提示解释为什么。
 *
 * 所以应用启动时读一次 localStorage，如果本地有配置就
 * **静默重放一次**给服务端。用户什么都不用做。
 *
 * ============ 为什么是"静默"的 ============
 *
 * 这里不该弹任何提示。配置同步成功是常态（用户自己填的，
 * 本来就该生效），失败也不该打断用户 —— 那只是"本次退回规则模式"，
 * 而规则模式本身是可用的。真正的失败提示放在设置页的「测试连接」里。
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'zhidao:llm-config';

interface SavedConfig {
  provider: string;
  baseURL: string;
  model: string;
  apiKey: string;
}

/**
 * 把浏览器里保存的配置重放给本地服务。
 *
 * <p>只做一次，失败静默。返回是否同步成功，仅供调试。
 */
export async function replaySavedLlmConfig(): Promise<boolean> {
  let cfg: SavedConfig | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw) as Partial<SavedConfig>;
    // 没有 Key 就没有可重放的东西 —— 空 Key 是"未配置"，不是一种配置
    if (!o.apiKey) return false;
    cfg = {
      provider: o.provider ?? 'deepseek',
      baseURL: o.baseURL ?? '',
      model: o.model ?? '',
      apiKey: o.apiKey,
    };
  } catch {
    return false;
  }

  try {
    const r = await fetch('/api/llm-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    return r.ok;
  } catch {
    return false;
  }
}
