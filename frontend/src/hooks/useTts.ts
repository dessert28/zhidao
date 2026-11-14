/* ------------------------------------------------------------------
 * 语音播报 —— window.speechSynthesis 封装
 * 依据：docs/03 §5「输出语音模态」；docs/05 §6 的 speech 事件
 *
 * 为什么用浏览器自带的 TTS 而不是云端合成：
 *
 *  1. **隐私一致性**。语音输入那一侧我们已经论证过"不让第三方听到患者说话"，
 *     输出侧如果反过来把"你的检查结果是…"这样的文本发给云厂商合成，
 *     这条边界就自相矛盾了。浏览器 TTS 全程在本机完成。
 *
 *  2. **适老化**。这是 docs/06 §2⑤ 的显式卖点：老花眼、不识字、
 *     或单纯不方便看屏幕的用户，听比看省力。
 *
 *  3. **成本与延迟都是零**，不占 API 额度、不需要网络。
 *
 * 三条必须处理的现实：
 *  - 浏览器的自动播放策略：**没有用户手势就不能自动朗读**。
 *    所以默认不自动播，由用户点按钮触发；想自动播的话会静默失败，
 *    而这个失败在控制台上什么都看不到（最容易误判成"功能没做"）。
 *  - 语音列表是**异步加载**的：`getVoices()` 首次调用常常返回空数组，
 *    要等 `voiceschanged`。不等就去设中文语音，会退回系统默认音色。
 *  - 长文本要分段：部分浏览器对单条 utterance 有字符上限，
 *    超长直接静默截断。
 * ------------------------------------------------------------------ */

import { useCallback, useEffect, useRef, useState } from 'react';

/** 单条播报的字符上限。Chrome 实测 32k 左右会截断，这里留足余量 */
const MAX_CHARS = 1500;

export type TtsStatus = 'idle' | 'speaking' | 'paused' | 'unsupported';

export interface UseTts {
  status: TtsStatus;
  /** 当前是否支持（不支持时不要显示按钮，或显示为不可用） */
  supported: boolean;
  /** 有没有中文音色。没有时仍能播，只是可能带口音 */
  hasZhVoice: boolean;
  speak: (text: string) => void;
  stop: () => void;
  toggle: (text: string) => void;
}

export function useTts(lang = 'zh-CN'): UseTts {
  const [status, setStatus] = useState<TtsStatus>(() =>
    typeof window !== 'undefined' && 'speechSynthesis' in window ? 'idle' : 'unsupported',
  );
  const [hasZhVoice, setHasZhVoice] = useState(false);

  // 当前正在说的话，用于"朗读中再点一次 = 停止"
  const currentRef = useRef<string | null>(null);

  const supported = status !== 'unsupported';

  /* ---------- 语音列表（异步加载，要等 voiceschanged） ---------- */
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const sync = () => {
      const voices = window.speechSynthesis.getVoices();
      setHasZhVoice(voices.some((v) => v.lang?.toLowerCase().startsWith('zh')));
    };

    sync(); // 有些浏览器首次就能拿到
    window.speechSynthesis.addEventListener('voiceschanged', sync);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', sync);
    };
  }, []);

  /* ---------- 卸载时停止，避免关掉页面还在说话 ---------- */
  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const stop = useCallback(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    currentRef.current = null;
    setStatus('idle');
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

      const content = prepareForSpeech(text);
      if (!content) return;

      // 先取消：连点两次不应该叠着念两遍
      window.speechSynthesis.cancel();

      const u = new SpeechSynthesisUtterance(content);
      u.lang = lang;
      u.rate = 0.95; // 稍慢一点，医疗信息听错代价很高
      u.pitch = 1;

      // 挑一个中文音色；没有就用系统默认（不阻断播放）
      const voices = window.speechSynthesis.getVoices();
      const zh = voices.find((v) => v.lang?.toLowerCase().startsWith('zh'));
      if (zh) u.voice = zh;

      u.onstart = () => setStatus('speaking');
      u.onend = () => {
        currentRef.current = null;
        setStatus('idle');
      };
      u.onerror = () => {
        // 用户手势缺失、被系统中断都会走这里。
        // 不弹错误：播报是增强功能，失败不该打扰正在看病的人。
        currentRef.current = null;
        setStatus('idle');
      };

      currentRef.current = content;
      window.speechSynthesis.speak(u);
    },
    [lang],
  );

  const toggle = useCallback(
    (text: string) => {
      if (status === 'speaking' || status === 'paused') {
        stop();
        return;
      }
      speak(text);
    },
    [status, speak, stop],
  );

  return { status, supported, hasZhVoice, speak, stop, toggle };
}

/**
 * 把要念的文本清理成人话。
 *
 * <p>不能直接把模型的输出丢给 TTS —— 里面有给眼睛看、用耳朵听会很怪的东西：
 *  - 引号书名号：念出来是"左引号""右引号"
 *  - Markdown 符号、「」会在一些音色里被逐字念
 *  - 过长的文本会被浏览器静默截断
 *
 * <p>粘性规则：宁可少念，也不要念出一串符号。
 */
export function prepareForSpeech(raw: string): string {
  if (!raw) return '';

  const cleaned = raw
    // 1. Markdown 列表符号先处理：行首的 - / * / + 是结构标记，不是内容。
    //    必须放在"去掉 *"之前，否则 "★ 第一条" 会先变成 " 第一条"，
    //    而 "- 第一条" 的短横会留成"减号"被念出来。
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    // 2. 换行：TTS 对 \n 的处理各浏览器不一致，有的会念"换行"。
    //    统一转成句号，天然形成停顿。
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, '。')
    // 3. 箭头、星号、井号、反引号这类装饰符号
    .replace(/[#*`>→←↑↓]/g, ' ')
    // 4. 各种括号：书名号直接去掉，圆括号变成停顿
    .replace(/[「」『』【】《》]/g, '')
    .replace(/[（）()[\]]/g, '，')
    // 5. 连续标点合并，避免念出"逗号逗号逗号"
    .replace(/[，,]{2,}/g, '，')
    .replace(/[。.]{2,}/g, '。')
    .replace(/，。/g, '。')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return cleaned.slice(0, MAX_CHARS);
}
