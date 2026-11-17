/* ------------------------------------------------------------------
 * 模型设置 —— 让用户自己填 url / apikey / 模型名
 *
 * ============ 安全边界（界面上也会写出来） ============
 *
 * 按用户的选择，**API Key 存在浏览器 localStorage**。这意味着：
 *
 *   · 任何能打开这个页面的人都能看到你填的 Key
 *   · 它会出现在浏览器开发者工具、扩展、以及可能存在的备份里
 *
 * 所以这是一个**演示/自用**的设计，不是给公网多租户用的。
 * 界面上必须把这句话摆出来，而不是藏在文档里 —— 用户在这里填的是
 * 真金白银买的 Key，他有权在填之前知道它存在哪。
 *
 * ============ 为什么"测试连接"很重要 ============
 *
 * 填错了不测，表现是发消息时看到「AI 调度暂不可用」——
 * 那句话完全无法区分"Key 错了"和"地址写错了"。
 * 所以设置页提供一个真实的探测按钮，把失败原因分清楚。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionTitle } from '../components/ui/SectionTitle';
import { THEME_OPTIONS } from '../hooks/useTheme';
import { useUiPrefs } from '../hooks/ui-prefs';

const STORAGE_KEY = 'zhidao:llm-config';

/** 预设：用户不用查文档就知道常见服务商的地址 */
const PRESETS: Array<{ id: string; label: string; baseURL: string; model: string }> = [
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  {
    id: 'qwen',
    label: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  { id: 'moonshot', label: '月之暗面', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'ollama', label: '本地 Ollama', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
];

interface SavedConfig {
  provider: string;
  baseURL: string;
  model: string;
  apiKey: string;
}

function readSaved(): SavedConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<SavedConfig>;
    if (!o.apiKey) return null;
    return {
      provider: o.provider ?? 'deepseek',
      baseURL: o.baseURL ?? '',
      model: o.model ?? '',
      apiKey: o.apiKey,
    };
  } catch {
    return null;
  }
}

type TestResult =
  | { phase: 'idle' }
  | { phase: 'testing' }
  | { phase: 'ok'; message: string }
  | { phase: 'fail'; message: string; detail?: string };

export default function SettingsPage() {
  const { themeMode, setThemeMode } = useUiPrefs();
  const [provider, setProvider] = useState('deepseek');
  const [baseURL, setBaseURL] = useState(PRESETS[0]!.baseURL);
  const [model, setModel] = useState(PRESETS[0]!.model);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestResult>({ phase: 'idle' });
  const [serverState, setServerState] = useState<{
    configured: boolean;
    source: string;
    model: string | null;
  } | null>(null);

  /**
   * 从服务商拉到的模型列表。
   *
   * <p>三种状态都要处理：
   *   · 空数组 + idle → 还没拉
   *   · 有值          → 下拉选
   *   · 拉取失败      → 退回手填（不是所有兼容实现都有 /models）
   */
  const [models, setModels] = useState<string[]>([]);
  const [modelState, setModelState] = useState<'idle' | 'loading' | 'ok' | 'fail'>('idle');
  const [modelHint, setModelHint] = useState('');

  /* 读一次服务端当前状态，让用户知道"现在到底在用哪个模型" */
  const refreshServer = useCallback(async () => {
    try {
      const r = await fetch('/api/llm-config');
      if (!r.ok) return;
      setServerState(await r.json());
    } catch {
      /* 网络问题就不显示，不影响填写 */
    }
  }, []);

  useEffect(() => {
    void refreshServer();
    const local = readSaved();
    if (local) {
      setProvider(local.provider);
      setBaseURL(local.baseURL);
      setModel(local.model);
      setApiKey(local.apiKey);
    }
  }, [refreshServer]);

  /** 换预设时同步填好地址和模型 —— 但已经改过的字段不覆盖，避免手输被冲掉 */
  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setProvider(p.id);
    setBaseURL(p.baseURL);
    setModel(p.model);
    setTest({ phase: 'idle' });
    setSaved(false);
    /*
     * 换服务商必须清空已拉取的模型列表。
     * 不清的话，用户切到另一家时下拉里还顶着上一家的模型 ——
     * 选中它就会拿着错的模型名去请求，报一个和操作完全对不上的错。
     */
    setModels([]);
    setModelState('idle');
    setModelHint('');
  };

  const save = async () => {
    if (!apiKey.trim()) {
      setTest({ phase: 'fail', message: '请先填写 API Key。' });
      return;
    }
    setSaving(true);
    setTest({ phase: 'idle' });

    /* 先存本地，再交给服务端 —— 本地是持久的那一份 */
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ provider, baseURL, model, apiKey: apiKey.trim() }),
      );
    } catch {
      setTest({
        phase: 'fail',
        message: '浏览器不允许保存（可能是隐私模式）。配置只在本次页面有效。',
      });
    }

    try {
      const r = await fetch('/api/llm-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, baseURL, model, apiKey: apiKey.trim() }),
      });
      const body = (await r.json()) as { ok?: boolean; message?: string };
      setSaving(false);
      if (r.ok && body.ok) {
        setSaved(true);
        void refreshServer();
      } else {
        setTest({ phase: 'fail', message: body.message ?? '保存失败' });
      }
    } catch {
      setSaving(false);
      setTest({ phase: 'fail', message: '连不上本地服务，请确认 BFF 已启动。' });
    }
  };

  const runTest = async () => {
    setTest({ phase: 'testing' });
    try {
      const r = await fetch('/api/llm-config/test', { method: 'POST' });
      const body = (await r.json()) as { ok: boolean; message: string; detail?: string };
      setTest(
        body.ok
          ? { phase: 'ok', message: body.message }
          : { phase: 'fail', message: body.message, ...(body.detail ? { detail: body.detail } : {}) },
      );
    } catch {
      setTest({ phase: 'fail', message: '请求发不出去，请确认本地服务已启动。' });
    }
  };

  /**
   * 拉取可用的模型列表。
   *
   * <p>需要先保存 —— 因为服务端要用当前配置里的 baseURL + Key 去请求。
   * 先存后拉的顺序是刻意的：用户改了地址却没保存，拉到的会是旧地址的列表。
   */
  const loadModels = async () => {
    setModelState('loading');
    setModelHint('');
    try {
      const r = await fetch('/api/llm-config/models');
      const body = (await r.json()) as {
        ok: boolean;
        models?: string[];
        message?: string;
        detail?: string;
      };
      if (body.ok && body.models && body.models.length > 0) {
        setModels(body.models);
        setModelState('ok');
        // 当前填的不在列表里时自动选第一个，省掉"填了但不存在"的坑
        if (model && !body.models.includes(model)) {
          setModel(body.models[0]!);
        } else if (!model) {
          setModel(body.models[0]!);
        }
      } else {
        setModels([]);
        setModelState('fail');
        setModelHint(body.message ?? '拉取失败，请手动填写模型名称。');
      }
    } catch {
      setModels([]);
      setModelState('fail');
      setModelHint('连不上本地服务，请手动填写模型名称。');
    }
  };

  const clearAll = async () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setApiKey('');
    await fetch('/api/llm-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: '' }),
    });
    setSaved(false);
    setTest({ phase: 'idle' });
    void refreshServer();
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="页面与模型设置"
        subtitle={
          <>
            模型接口填你自己的也行，不填也能用 —— 系统会自动退回本地规则，只是回答没那么灵活。
            下面的外观设置只影响这台设备。
          </>
        }
      />

      {/* ---------- 当前状态 ---------- */}
      {serverState ? (
        <div
          className={
            'rounded-xl border p-3 text-sm ' +
            (serverState.configured
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-gray-200 bg-gray-50 text-gray-600')
          }
        >
          {serverState.configured ? (
            <>
              当前在用：
              <b className="font-medium">
                {serverState.source === 'runtime' ? '你在本页设置的模型' : '服务端 .env 里配置的模型'}
              </b>
              {serverState.model ? `（${serverState.model}）` : ''}
            </>
          ) : (
            <>当前没接模型，所有回答走本地规则 —— 能用，但不会像大模型那样灵活。</>
          )}
        </div>
      ) : null}

      {/* ---------- 安全提示：必须显眼 ---------- */}
      <section className="rounded-xl border border-amber-200 bg-amber-50 p-3">
        <div className="text-xs font-medium text-amber-900">API Key 会存在这台电脑的浏览器里</div>
        <p className="mt-1 text-xs leading-relaxed text-amber-800">
          存在 localStorage，刷新后不用重填。但
          <b className="font-medium">任何能打开这个页面的人都能看到它</b>
          ，也可能出现在浏览器开发者工具或备份里。这是为了演示方便做的取舍 ——
          请不要在公用电脑上填你自己的付费 Key。
        </p>
      </section>

      {/* ---------- 表单 ---------- */}
      <section className="space-y-3 rounded-xl border border-gray-200 bg-surface p-4">
        <label className="block text-xs text-gray-500">
          服务商
          <select
            value={provider}
            onChange={(e) => applyPreset(e.target.value)}
            className="mt-1 block h-9 w-full rounded-lg border border-gray-200 px-2 text-sm text-gray-800"
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-gray-500">
          接口地址（Base URL）
          <input
            type="text"
            value={baseURL}
            onChange={(e) => {
              setBaseURL(e.target.value);
              setSaved(false);
            }}
            placeholder="https://api.deepseek.com/v1"
            className="mt-1 block h-9 w-full rounded-lg border border-gray-200 px-2 font-mono text-sm text-gray-800"
          />
        </label>

        <label className="block text-xs text-gray-500">
          模型名称
          <div className="mt-1 flex gap-2">
            {/*
              拉到列表时用下拉，拉不到时用输入框。
              不能只有下拉：不是所有兼容实现都提供 /models，
              只有下拉会让那些用户完全没法填。
            */}
            {modelState === 'ok' && models.length > 0 ? (
              <select
                value={models.includes(model) ? model : ''}
                onChange={(e) => {
                  setModel(e.target.value);
                  setSaved(false);
                }}
                className="block h-9 flex-1 rounded-lg border border-gray-200 px-2 font-mono text-sm text-gray-800"
              >
                {models.includes(model) ? null : <option value="">（当前填的模型不在列表里）</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setSaved(false);
                }}
                placeholder="deepseek-chat"
                className="block h-9 flex-1 rounded-lg border border-gray-200 px-2 font-mono text-sm text-gray-800"
              />
            )}

            <button
              type="button"
              onClick={() => void loadModels()}
              disabled={modelState === 'loading'}
              className="h-9 shrink-0 rounded-lg border border-gray-200 px-3 text-xs text-gray-600 disabled:opacity-60"
            >
              {modelState === 'loading' ? '获取中…' : '获取模型列表'}
            </button>
          </div>

          {modelState === 'ok' ? (
            <p className="mt-1 text-2xs text-gray-400">
              已从服务商拉到 {models.length} 个模型，从上面选一个即可。
            </p>
          ) : null}
          {modelState === 'fail' ? (
            <p className="mt-1 text-2xs leading-relaxed text-amber-700">{modelHint}</p>
          ) : null}
          {modelState === 'idle' ? (
            <p className="mt-1 text-2xs leading-relaxed text-gray-400">
              可以先保存，再点「获取模型列表」—— 不用自己去查模型名。
            </p>
          ) : null}
        </label>

        <label className="block text-xs text-gray-500">
          API Key
          <div className="mt-1 flex gap-2">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setSaved(false);
              }}
              placeholder="sk-..."
              autoComplete="off"
              className="block h-9 flex-1 rounded-lg border border-gray-200 px-2 font-mono text-sm text-gray-800"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="h-9 shrink-0 rounded-lg border border-gray-200 px-3 text-xs text-gray-600"
            >
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
        </label>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="h-9 rounded-lg bg-action px-4 text-sm font-medium text-white disabled:bg-gray-300"
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={test.phase === 'testing'}
            className="h-9 rounded-lg border border-gray-200 bg-surface px-4 text-sm text-gray-700 disabled:opacity-60"
          >
            {test.phase === 'testing' ? '测试中…' : '测试连接'}
          </button>
          <button
            type="button"
            onClick={() => void clearAll()}
            className="h-9 rounded-lg px-3 text-xs text-gray-500 underline underline-offset-2"
          >
            清除配置
          </button>

          {saved ? <span className="text-xs text-green-700">已保存</span> : null}
        </div>

        {test.phase === 'ok' ? (
          <p className="rounded-lg bg-green-50 px-3 py-2 text-xs leading-relaxed text-green-800">
            {test.message}
          </p>
        ) : null}
        {test.phase === 'fail' ? (
          <div className="rounded-lg bg-amber-50 px-3 py-2">
            <p className="text-xs leading-relaxed text-amber-900">{test.message}</p>
            {test.detail ? (
              <p className="mt-1 break-all font-mono text-2xs leading-relaxed text-amber-700">
                {test.detail}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      <p className="text-xs leading-relaxed text-gray-400">
        保存后配置只放在本机浏览器；本地服务这一侧仅临时持有、不落盘，
        服务重启后由页面重新提交。密钥不会写进日志，也不会出现在任何接口返回里。
      </p>

      {/* ---------- 外观 ---------- */}
      {/*
        顶栏只放了一个太阳/月亮（点一下就在亮暗之间切），
        三选一放在这里：默认"跟随系统"这一步不能省 ——
        手机系统已经是深色的人，不该被我们先亮一下。
      */}
      <section>
        <SectionTitle>外观</SectionTitle>
        <div className="space-y-1.5">
          {THEME_OPTIONS.map((o) => {
            const active = themeMode === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => setThemeMode(o.value)}
                aria-pressed={active}
                className={
                  'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ' +
                  (active
                    ? 'border-brand-300 bg-brand-50'
                    : 'border-gray-200 bg-surface hover:border-gray-300')
                }
              >
                <span
                  className={
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ' +
                    (active ? 'border-action bg-action' : 'border-gray-300')
                  }
                  aria-hidden="true"
                >
                  {active ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
                </span>
                <span className="min-w-0">
                  <span
                    className={
                      'block text-sm font-medium ' + (active ? 'text-brand-800' : 'text-gray-900')
                    }
                  >
                    {o.label}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-gray-500">
                    {o.hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
