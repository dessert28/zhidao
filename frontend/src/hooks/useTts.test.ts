/* ------------------------------------------------------------------
 * TTS 测试
 *
 * 分两块：
 *   1. prepareForSpeech —— 纯函数，**这才是真正会出错的地方**。
 *      模型的输出里有「」、Markdown 符号，直接丢给 TTS 会被逐字念出来。
 *   2. useTts —— 只测降级路径（不支持 / 停止 / 重复点击不叠音）。
 *      不断言"嗓子好不好听"，那是设备的事。
 * ------------------------------------------------------------------ */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareForSpeech, useTts } from './useTts';

/* ============================ 文本清理 ============================ */

describe('prepareForSpeech：把给人看的文本变成给人听的', () => {
  it('去掉书名号与引号，避免念出"左引号"', () => {
    expect(prepareForSpeech('建议挂「消化内科」')).toBe('建议挂消化内科');
    expect(prepareForSpeech('参考《就诊指南》')).toBe('参考就诊指南');
  });

  it('括号转成停顿，而不是被念出来', () => {
    expect(prepareForSpeech('空腹血糖（mmol/L）偏高')).toBe('空腹血糖，mmol/L，偏高');
  });

  it('去掉 Markdown 装饰符号', () => {
    expect(prepareForSpeech('## 结论\n* 第一条\n- 第二条')).toBe('结论。第一条。第二条');
  });

  it('合并连续标点，避免念出"逗号逗号逗号"', () => {
    expect(prepareForSpeech('注意，，，要空腹')).toBe('注意，要空腹');
    expect(prepareForSpeech('结束了。。。')).toBe('结束了。');
  });

  it('箭头与星号被替换成空格', () => {
    expect(prepareForSpeech('急症 → 拨打120')).toBe('急症 拨打120');
  });

  it('超长文本被截断（浏览器会静默截断，不给它机会）', () => {
    const long = '一'.repeat(5000);
    expect(prepareForSpeech(long).length).toBe(1500);
  });

  it('空输入返回空串，不抛异常', () => {
    expect(prepareForSpeech('')).toBe('');
    expect(prepareForSpeech('   ')).toBe('');
  });

  it('正常句子不被改动', () => {
    const s = '距离上次糖化血红蛋白已 61 天，建议复查。';
    expect(prepareForSpeech(s)).toBe(s);
  });
});

/* ============================ hook ============================ */

/** 最小可用的假 speechSynthesis */
class FakeSynthesis {
  spoken: string[] = [];
  cancelled = 0;
  private handlers: Record<string, Array<() => void>> = {};

  getVoices() {
    return [{ lang: 'zh-CN', name: 'Fake Chinese' }] as SpeechSynthesisVoice[];
  }
  speak(u: SpeechSynthesisUtterance) {
    this.spoken.push(u.text);
    u.onstart?.(new Event('start') as never);
  }
  cancel() {
    this.cancelled++;
  }
  addEventListener(type: string, fn: () => void) {
    (this.handlers[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.handlers[type] = (this.handlers[type] ?? []).filter((f) => f !== fn);
  }
}

let fake: FakeSynthesis;

beforeEach(() => {
  fake = new FakeSynthesis();
  Object.defineProperty(window, 'speechSynthesis', {
    value: fake,
    configurable: true,
    writable: true,
  });
  // jsdom 没有 SpeechSynthesisUtterance
  (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = class {
    text: string;
    lang = '';
    rate = 1;
    pitch = 1;
    voice: unknown = null;
    onstart: ((e: unknown) => void) | null = null;
    onend: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  };
});

afterEach(() => {
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
  delete (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
  vi.restoreAllMocks();
});

describe('useTts', () => {
  it('给出 supported=true 且有中文音色', () => {
    const { result } = renderHook(() => useTts());
    expect(result.current.supported).toBe(true);
    expect(result.current.hasZhVoice).toBe(true);
  });

  it('speak 会真的调 speechSynthesis.speak，且文本已清理', () => {
    const { result } = renderHook(() => useTts());
    act(() => result.current.speak('建议挂「消化内科」'));
    expect(fake.spoken).toHaveLength(1);
    expect(fake.spoken[0]).toBe('建议挂消化内科');
  });

  it('speaking 状态在 onstart 后成立', () => {
    const { result } = renderHook(() => useTts());
    act(() => result.current.speak('你好'));
    expect(result.current.status).toBe('speaking');
  });

  it('连续两次 speak 会先 cancel，不叠着念两遍', () => {
    const { result } = renderHook(() => useTts());
    act(() => result.current.speak('第一句'));
    act(() => result.current.speak('第二句'));
    expect(fake.cancelled).toBeGreaterThanOrEqual(1);
  });

  it('toggle 在朗读中再点一次 = 停止', () => {
    const { result } = renderHook(() => useTts());
    act(() => result.current.speak('你好'));
    expect(result.current.status).toBe('speaking');

    act(() => result.current.toggle('你好'));
    expect(result.current.status).toBe('idle');
    expect(fake.cancelled).toBeGreaterThanOrEqual(1);
  });

  it('空文本不发起播报', () => {
    const { result } = renderHook(() => useTts());
    act(() => result.current.speak('   '));
    expect(fake.spoken).toHaveLength(0);
  });

  it('卸载时 cancel，避免关掉页面还在说话', () => {
    const { result, unmount } = renderHook(() => useTts());
    act(() => result.current.speak('你好'));
    const before = fake.cancelled;
    unmount();
    expect(fake.cancelled).toBeGreaterThan(before);
  });

  it('浏览器不支持时 status=unsupported，且调用不抛异常', () => {
    delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
    const { result } = renderHook(() => useTts());
    expect(result.current.supported).toBe(false);
    expect(result.current.status).toBe('unsupported');
    expect(() => act(() => result.current.speak('你好'))).not.toThrow();
  });
});
