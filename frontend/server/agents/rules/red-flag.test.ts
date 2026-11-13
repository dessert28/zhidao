/* ------------------------------------------------------------------
 * 红线规则引擎的测试 —— 这是"AI 安全"最硬的证据，必须先绿
 * 运行：pnpm test
 * ------------------------------------------------------------------ */

import { describe, expect, it } from 'vitest';
import { checkRedFlag, RED_FLAG_RULE_COUNT, recheckAnswer } from './red-flag.js';

describe('红线规则引擎', () => {
  it('规则表不为空', () => {
    expect(RED_FLAG_RULE_COUNT).toBeGreaterThanOrEqual(5);
  });

  describe('命中即短路', () => {
    const cases: Array<[string, string]> = [
      ['胸口疼得厉害', 'chest_pain'],
      ['这两天胸痛', 'chest_pain'],
      ['感觉心口窝闷', 'chest_pain'],
      ['早上起来嘴角歪了', 'stroke'],
      ['一侧手脚没力气', 'stroke'],
      ['半边身子使不上劲', 'stroke'],
      ['左边手脚发麻', 'stroke'],
      ['说话含糊不清', 'stroke'],
      ['晚上喘不上气', 'dyspnea'],
      ['走两步就呼吸困难', 'dyspnea'],
      ['老人叫不醒了', 'consciousness'],
      ['突然晕倒', 'consciousness'],
      ['抽风了一次', 'consciousness'],
      ['呕血了', 'hemorrhage'],
      ['大出血止不住', 'hemorrhage'],
      ['黑便三天', 'hemorrhage'],
    ];

    it.each(cases)('「%s」命中 %s', (text, expected) => {
      const r = checkRedFlag(text);
      expect(r.hit).not.toBeNull();
      expect(r.hit?.type).toBe(expected);
      expect(r.hit?.guidance.length).toBeGreaterThan(10);
    });
  });

  describe('不误报普通描述', () => {
    const safe = [
      '我想挂个号',
      '血糖高要注意什么',
      '最近有点失眠',
      '这个指标比半年前下降了 15%',
      '明天上午有空吗',
    ];

    it.each(safe)('「%s」不触发', (text) => {
      expect(checkRedFlag(text).hit).toBeNull();
    });
  });

  it('多重命中时返回第一条，但记下全部类型', () => {
    const r = checkRedFlag('突然胸痛而且喘不上气');
    expect(r.hit).not.toBeNull();
    expect(r.matchedTypes.length).toBeGreaterThanOrEqual(2);
  });

  it('Reviewer 复检能识别答案里的急症词', () => {
    expect(recheckAnswer('你这种情况可能是胸痛引起的心梗')).not.toBeNull();
    expect(recheckAnswer('建议挂心内科门诊')).toBeNull();
  });

  it('guidance 必须是可执行动作，不是免责声明', () => {
    const r = checkRedFlag('胸痛');
    expect(r.hit?.guidance).toMatch(/120|急诊|拨/);
  });
});
