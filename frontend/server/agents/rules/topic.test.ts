import { describe, it, expect } from 'vitest';
import {
  detectEmotion,
  isTopicSwitch,
  EMOTION_COMFORT,
  EMOTION_CAVEAT,
  EMOTION_DEPARTMENTS,
} from './topic.js';

describe('detectEmotion', () => {
  it('命中失恋类主诉', () => {
    expect(detectEmotion('我失恋了，不舒服').hit).toBe(true);
    expect(detectEmotion('和男朋友分手了，心里很难受').hit).toBe(true);
  });

  it('命中焦虑/压力类主诉', () => {
    expect(detectEmotion('最近工作压力很大，睡不着').hit).toBe(true);
    expect(detectEmotion('我好像有点抑郁').hit).toBe(true);
  });

  it('不误判普通躯体症状', () => {
    expect(detectEmotion('我肚子胀痛三天了').hit).toBe(false);
    expect(detectEmotion('胸口闷，有点疼').hit).toBe(false);
    // 单独的"不舒服"不该判成情绪
    expect(detectEmotion('不舒服').hit).toBe(false);
  });
});

describe('isTopicSwitch', () => {
  const oldSlots = { 部位: '肚子', 时长: '三天', 性质: '胀痛' };

  it('情绪主诉 → 换话题', () => {
    expect(isTopicSwitch('我失恋了，不舒服', oldSlots)).toBe(true);
  });

  it('全新躯体症状（旧槽位没有）→ 换话题', () => {
    expect(isTopicSwitch('我头晕得厉害', oldSlots)).toBe(true);
  });

  it('短回答/补充描述 → 延续追问', () => {
    expect(isTopicSwitch('嗯', oldSlots)).toBe(false);
    expect(isTopicSwitch('三天了', oldSlots)).toBe(false);
    expect(isTopicSwitch('就是肚子这里', oldSlots)).toBe(false);
  });

  it('旧槽位里已有的症状词不算新话题', () => {
    // 肚子在旧槽位里
    expect(isTopicSwitch('肚子还是胀', oldSlots)).toBe(false);
  });
});

describe('情绪话术', () => {
  it('共情开场存在且不做诊断', () => {
    expect(EMOTION_COMFORT.length).toBeGreaterThan(10);
    expect(EMOTION_COMFORT).not.toMatch(/抑郁|焦虑症|确诊/);
  });

  it('提示包含心理科与危机热线，但明确不是诊断', () => {
    expect(EMOTION_CAVEAT).toMatch(/心理|精神/);
    expect(EMOTION_CAVEAT).toMatch(/12356/);
  });

  it('科室建议以心理科为首', () => {
    expect(EMOTION_DEPARTMENTS[0]!.name).toBe('临床心理科');
  });
});
