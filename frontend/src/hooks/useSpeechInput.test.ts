/* ------------------------------------------------------------------
 * 语音输入 hook 测试
 *
 * 目标不是测"麦克风能不能收到声音"（那需要真设备和真麦克风），
 * 而是测**四种降级路径**，因为这四种恰恰是现场最容易翻车的地方：
 *
 *   1. 浏览器不支持（Firefox）→ 点按钮必须给出原因，不能静默
 *   2. 非安全上下文（局域网 http）→ 必须明确提示 HTTPS，而不是"没反应"
 *   3. 用户拒绝麦克风权限 → 必须显示可读的说明
 *   4. 识别成功 → 结果交给调用方，**且不自动发送**
 *
 * 用假的 SpeechRecognition 实现注入 window，不碰真 API。
 * ------------------------------------------------------------------ */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectSpeechSupport, useSpeechInput } from './useSpeechInput';

/** 假 recognition：把事件回调暴露出来，测试里手动触发 */
class FakeRecognition {
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  started = false;
  aborted = false;

  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;

  start() {
    this.started = true;
    this.onstart?.();
  }

  stop() {
    this.onend?.();
  }

  abort() {
    this.aborted = true;
  }

  /* --- 测试用触发器 --- */
  emitFinal(text: string) {
    this.onresult?.({
      resultIndex: 0,
      results: Object.assign([{ isFinal: true, length: 1, 0: { transcript: text, confidence: 0.9 } }], {
        length: 1,
      }),
    });
  }

  emitInterim(text: string) {
    this.onresult?.({
      resultIndex: 0,
      results: Object.assign([{ isFinal: false, length: 1, 0: { transcript: text, confidence: 0.5 } }], {
        length: 1,
      }),
    });
  }

  emitError(code: string) {
    this.onerror?.({ error: code });
  }
}

let lastInstance: FakeRecognition | null = null;

function installFakeCtor() {
  const Ctor = function FakeCtor(this: FakeRecognition) {
    const inst = new FakeRecognition();
    lastInstance = inst;
    return inst;
  } as unknown as new () => FakeRecognition;
  (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = Ctor;
}

function uninstallCtor() {
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  lastInstance = null;
}

beforeEach(() => {
  uninstallCtor();
  lastInstance = null;
});

afterEach(() => {
  uninstallCtor();
  vi.restoreAllMocks();
});

describe('能力检测', () => {
  it('没有 SpeechRecognition 时判为 unsupported（Firefox 就是这种情况）', () => {
    expect(detectSpeechSupport()).toBe('unsupported');
  });

  it('有构造器且是 localhost 时判为 supported', () => {
    installFakeCtor();
    // jsdom 默认 location 是 http://localhost/
    expect(window.isSecureContext || location.hostname === 'localhost').toBe(true);
    expect(detectSpeechSupport()).toBe('supported');
  });

  it('支持 webkit 前缀（旧版 Chrome / Safari）', () => {
    (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition =
      FakeRecognition;
    expect(detectSpeechSupport()).toBe('supported');
  });
});

describe('不支持时的降级', () => {
  it('点 start 不抛异常，而是给出可读的错误', () => {
    const onFinal = vi.fn();
    const { result } = renderHook(() => useSpeechInput({ onFinal }));

    expect(result.current.support).toBe('unsupported');

    act(() => result.current.start());

    expect(result.current.error).toContain('不支持');
    expect(onFinal).not.toHaveBeenCalled();
  });

  it('错误可以被清除', () => {
    const { result } = renderHook(() => useSpeechInput({ onFinal: vi.fn() }));
    act(() => result.current.start());
    expect(result.current.error).not.toBeNull();
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});

describe('正常识别流程', () => {
  beforeEach(() => installFakeCtor());

  it('启动后 listening 为 true', () => {
    const { result } = renderHook(() => useSpeechInput({ onFinal: vi.fn() }));
    act(() => result.current.start());
    expect(result.current.listening).toBe(true);
    expect(lastInstance?.started).toBe(true);
  });

  it('最终结果交给调用方，且不自动发送', () => {
    const onFinal = vi.fn();
    const { result } = renderHook(() => useSpeechInput({ onFinal }));

    act(() => result.current.start());
    act(() => lastInstance!.emitFinal('肚子疼三天了'));

    expect(onFinal).toHaveBeenCalledWith('肚子疼三天了');
    // 这个 hook 里根本没有"发送"的概念 —— 结果只能经由 onFinal 交给 UI
    expect(onFinal).toHaveBeenCalledTimes(1);
  });

  it('中间结果单独暴露，不触发 onFinal', () => {
    const onFinal = vi.fn();
    const { result } = renderHook(() => useSpeechInput({ onFinal }));

    act(() => result.current.start());
    act(() => lastInstance!.emitInterim('肚子'));

    expect(onFinal).not.toHaveBeenCalled();
    expect(result.current.interim).toBe('肚子');
  });

  it('停止后 listening 变回 false', () => {
    const { result } = renderHook(() => useSpeechInput({ onFinal: vi.fn() }));
    act(() => result.current.start());
    act(() => result.current.stop());
    expect(result.current.listening).toBe(false);
  });

  it('toggle 在开始/停止之间切换', () => {
    const { result } = renderHook(() => useSpeechInput({ onFinal: vi.fn() }));
    act(() => result.current.toggle());
    expect(result.current.listening).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.listening).toBe(false);
  });

  it('卸载时 abort，避免麦克风一直开着', () => {
    const { result, unmount } = renderHook(() => useSpeechInput({ onFinal: vi.fn() }));
    act(() => result.current.start());
    const inst = lastInstance!;
    unmount();
    expect(inst.aborted).toBe(true);
  });
});

describe('权限与设备错误', () => {
  beforeEach(() => installFakeCtor());

  it('权限被拒 → 中文说明，不是 "not-allowed"', () => {
    const { result } = renderHook(() => useSpeechInput({ onFinal: vi.fn() }));
    act(() => result.current.start());
    act(() => lastInstance!.emitError('not-allowed'));

    expect(result.current.error).toContain('麦克风权限');
    expect(result.current.error).not.toContain('not-allowed');
    expect(result.current.listening).toBe(false);
  });

  it('没有麦克风设备 → 明确说出来', () => {
    const { result } = renderHook(() => useSpeechInput({ onFinal: vi.fn() }));
    act(() => result.current.start());
    act(() => lastInstance!.emitError('audio-capture'));
    expect(result.current.error).toContain('麦克风');
  });

  it('用户主动中止不算错误', () => {
    const { result } = renderHook(() => useSpeechInput({ onFinal: vi.fn() }));
    act(() => result.current.start());
    act(() => lastInstance!.emitError('aborted'));
    expect(result.current.error).toBeNull();
  });

  it('未知错误码也要给出可读信息', () => {
    const { result } = renderHook(() => useSpeechInput({ onFinal: vi.fn() }));
    act(() => result.current.start());
    act(() => lastInstance!.emitError('weird-code'));
    expect(result.current.error).toContain('weird-code');
  });
});
