/* ------------------------------------------------------------------
 * 语音输入 —— Web Speech API 封装
 * 依据：docs/06-AI用途全景.md ⑤ 适老化语音；docs/03 §5 输入三模态
 *
 * ============ 先说实话：它不保证端侧 ============
 *
 * 上一版这里的注释写着「语音在设备上就被转成文字，没有任何一家第三方
 * 听到患者说话」。**这句话是错的**，而且错在最不该错的地方 —— 隐私承诺。
 *
 * 实际情况（按实现分三种）：
 *
 *   1. Chrome / Edge 的 webkitSpeechRecognition
 *      音频发回厂商的识别服务，识别在**云端**完成。
 *      所以"第三方听不到"不成立：那是把一个云端 ASR 换个名字而已。
 *
 *   2. iOS Safari（WebKit 实现）
 *      同样依赖 Apple 的识别服务，是否离开设备取决于系统设置。
 *
 *   3. 完全本地的实现（如部分平台的 on-device 模式、或自带模型）
 *      这一类才真的"不出设备"，但我们无法从 JS 侧判断当前是哪种。
 *
 * 浏览器没有提供任何 API 告诉页面"这次识别是本地还是云端"，
 * 所以这里**不能假装知道**。产品上分两步处理：
 *
 *   · 麦克风按钮旁常驻一句说明（SPEECH_PRIVACY_NOTICE），
 *     让用户在按之前就知道音频会离开设备；
 *   · 识别文字进输入框后照常走 redact() —— 文本那一段的隐私边界不受影响，
 *     受影响的只是"声音"这一段。
 *
 * ============ 为什么仍然用它 ============
 *
 *  1. 适老化。60 岁以上用户打字描述症状的意愿很低，
 *     而说"肚子这块疼了三天"是自然的。这是 docs/06 §2⑤ 的显式卖点。
 *  2. 不需要自己部署模型，成本为零，不占 API 额度。
 *  3. 可以随时按 docs/02 的预案换成端侧 Whisper（transformers.js），
 *     届时这条注释和那句提示一起改 —— 而且那时才真的能说"不出设备"。
 *
 * 已知限制（必须如实写在 UI 上）：
 *  - 只有 Chrome / Edge / Safari 支持（Firefox 不支持，且不会实现）
 *  - **必须 HTTPS 或 localhost**，局域网 http://192.168.x.x 会直接拒绝。
 *    这是评委现场最容易踩的坑，所以不支持时要把原因说清楚，而不是按钮没反应
 *  - 中文识别质量取决于设备，医学词容易错（"心悸"→"心急"），
 *    所以识别结果是**可编辑的文字**，不是直接发送
 * ------------------------------------------------------------------ */

/** 界面上必须显示的那句话。写成常量，保证每处说法一致 */
export const SPEECH_PRIVACY_NOTICE =
  '语音会先交给浏览器的识别服务（Chrome / Edge 为云端识别），识别后的文字再在本机脱敏。不想让声音离开设备，请用键盘输入。';

import { useCallback, useEffect, useRef, useState } from 'react';

/** 浏览器支持情况。unsupported 时要给用户一个明确的原因，不能只是按钮变灰 */
export type SpeechSupport = 'idle' | 'supported' | 'unsupported' | 'insecure';

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

/**
 * 最小可用的 SpeechRecognition 类型。
 *
 * <p>不引 @types/dom-speech-recognition：它只为了几行声明拉进一个依赖，
 * 而且 TS 的 lib.dom 在不同版本里对这几个接口的覆盖很不一致
 * （有的版本有 SpeechRecognition 没有 webkitSpeechRecognition，反之亦然）。
 * 自己声明反而稳定。
 */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type Ctor = new () => SpeechRecognitionLike;

function getCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: Ctor;
    webkitSpeechRecognition?: Ctor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * 判断当前环境能不能用语音。
 *
 * <p>{@code insecure} 单独区分出来是有意的：HTTPS 限制导致的失败，
 * 表现是"点了一下什么都没发生"，而开发者控制台只有一行
 * "not-allowed" —— 不把它单独说明，现场根本查不出来。
 */
export function detectSpeechSupport(): SpeechSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!getCtor()) return 'unsupported';
  const secure = window.isSecureContext || location.hostname === 'localhost';
  return secure ? 'supported' : 'insecure';
}

export interface UseSpeechInputOptions {
  /** 识别出最终结果时回调。调用方负责把它拼进输入框，不要自动发送 */
  onFinal: (text: string) => void;
  lang?: string;
}

export interface UseSpeechInput {
  support: SpeechSupport;
  listening: boolean;
  /** 正在说的那半句（可以显示出来让用户知道"它在听"） */
  interim: string;
  /** 最近一次错误的中文说明；没有则为 null */
  error: string | null;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  clearError: () => void;
}

/** 错误码 → 人话。浏览器给的是 not-allowed / no-speech 这种，用户看不懂 */
const ERROR_TEXT: Record<string, string> = {
  'not-allowed': '麦克风权限被拒绝了。请在浏览器地址栏左侧的图标里允许使用麦克风。',
  'service-not-allowed': '浏览器拒绝了语音服务，可能需要改用 Chrome 或 Edge。',
  'no-speech': '没有听到声音，请靠近麦克风再说一次。',
  'audio-capture': '没有检测到麦克风设备。',
  network: '语音识别服务连接失败。Chrome 的识别需要联网。',
  aborted: '', // 用户主动停止，不算错误
};

export function useSpeechInput({ onFinal, lang = 'zh-CN' }: UseSpeechInputOptions): UseSpeechInput {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  // support 只算一次：它取决于浏览器能力，运行期不会变
  const [support] = useState<SpeechSupport>(detectSpeechSupport);

  const recRef = useRef<SpeechRecognitionLike | null>(null);

  /**
   * onFinal 每次渲染都可能是新函数（inline 箭头）。
   * 把它放进 ref，避免因为回调变化而重建 recognition 实例 ——
   * 重建会打断正在进行的识别。
   */
  const onFinalRef = useRef(onFinal);
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  // 组件卸载时一定要 abort，否则麦克风会一直开着
  useEffect(() => {
    return () => {
      recRef.current?.abort();
      recRef.current = null;
    };
  }, []);

  const ensureRecognition = useCallback((): SpeechRecognitionLike | null => {
    if (recRef.current) return recRef.current;
    const Ctor = getCtor();
    if (!Ctor) return null;

    const rec = new Ctor();
    rec.lang = lang;
    // continuous=false：说一句就结束。
    // 开着 continuous 在移动端会一直占用麦克风，用户很容易忘记关。
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setListening(true);
      setError(null);
    };

    rec.onresult = (e) => {
      let finalText = '';
      let partial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r) continue;
        const alt = r[0];
        if (!alt) continue;
        if (r.isFinal) finalText += alt.transcript;
        else partial += alt.transcript;
      }
      setInterim(partial);
      if (finalText.trim()) {
        // 只把结果交给调用方拼进输入框，**不自动发送** ——
        // 医学词识别错误率不低（"心悸"→"心急"），必须让人过一眼
        onFinalRef.current(finalText.trim());
        setInterim('');
      }
    };

    rec.onerror = (e) => {
      const msg = ERROR_TEXT[e.error] ?? `语音识别出错（${e.error}）`;
      if (msg) setError(msg);
      setListening(false);
      setInterim('');
    };

    rec.onend = () => {
      setListening(false);
      setInterim('');
    };

    recRef.current = rec;
    return rec;
  }, [lang]);

  const start = useCallback(() => {
    if (support !== 'supported') {
      setError(
        support === 'insecure'
          ? '语音输入需要 HTTPS 或 localhost 环境。当前是通过局域网 IP 访问的，浏览器会拒绝麦克风。'
          : '当前浏览器不支持语音输入，建议使用 Chrome 或 Edge。',
      );
      return;
    }
    const rec = ensureRecognition();
    if (!rec) return;
    try {
      rec.start();
    } catch {
      // 已经在识别中时再 start() 会抛 InvalidStateError，忽略即可
    }
  }, [support, ensureRecognition]);

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const toggle = useCallback(() => {
    if (listening) stop();
    else start();
  }, [listening, start, stop]);

  const clearError = useCallback(() => setError(null), []);

  return { support, listening, interim, error, start, stop, toggle, clearError };
}
