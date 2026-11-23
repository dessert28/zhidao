/* ------------------------------------------------------------------
 * 卡片本地渲染 —— 只盯一件事：**没有 html 也要看得见**。
 *
 * 背景：AI 迁到 Spring Boot 后，Java 侧不产出 event.html，
 * 而 EventRenderer 曾经是「没有 html 就 return null」，
 * 结果科室卡、急症卡、免责条全静默消失 —— 页面上只剩一句纯文字，
 * 用户以为功能没了。这几个用例就是钉住这个回归：
 * 事件里带 props、不带 html，也必须渲染出对应内容。
 * ------------------------------------------------------------------ */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EventRenderer } from './EventRenderer';
import { DepartmentCard, EmergencyCard } from './AgentCards';
import type { StreamEvent } from '../hooks/useEventStream';

afterEach(() => cleanup());

describe('科室推荐卡（无服务端 html）', () => {
  const event = {
    type: 'department_card',
    departments: [
      { name: '神经内科', confidence: 0.72, reason: '头晕持续数小时，属急性起病' },
      { name: '心血管内科', confidence: 0.4, reason: '作为备选，建议先到导诊台确认' },
    ],
  } as unknown as StreamEvent;

  it('渲染科室名、理由与置信度百分比', () => {
    render(<EventRenderer event={event} />);

    expect(screen.getByText('神经内科')).toBeTruthy();
    expect(screen.getByText('头晕持续数小时，属急性起病')).toBeTruthy();
    expect(screen.getByText('72%')).toBeTruthy();
    expect(screen.getByText('心血管内科')).toBeTruthy();
  });

  it('只给第一个科室打「首选」，其余不打', () => {
    render(<EventRenderer event={event} />);
    expect(screen.getAllByText('首选')).toHaveLength(1);
  });

  it('科室为空时给可执行的去处，不留白', () => {
    render(<DepartmentCard departments={[]} />);
    expect(screen.getByText(/门诊导诊台/)).toBeTruthy();
  });
});

describe('急症卡（无服务端 html）', () => {
  it('渲染红线标题与处置指引', () => {
    render(
      <EventRenderer
        event={{
          type: 'emergency',
          redFlag: { type: 'chest_pain', guidance: '请立即拨打 120，不要自行驾车前往。' },
        } as unknown as StreamEvent}
      />,
    );

    expect(screen.getByText('胸痛 · 需立即处理')).toBeTruthy();
    expect(screen.getByText('请立即拨打 120，不要自行驾车前往。')).toBeTruthy();
  });

  it('未知红线类型不至于渲染出 undefined', () => {
    render(<EmergencyCard redFlag={{ type: 'x' as never, guidance: '尽快就医。' }} />);
    expect(screen.getByText('需要立即处理')).toBeTruthy();
  });
});

describe('免责说明条（无服务端 html）', () => {
  it('渲染说明原文', () => {
    render(
      <EventRenderer
        event={{ type: 'caveat', text: '本回答仅用于就诊准备参考，不构成诊断。' } as unknown as StreamEvent}
      />,
    );
    expect(screen.getByText(/不构成诊断/)).toBeTruthy();
  });
});

describe('服务端 html 仍优先', () => {
  it('事件带 html 时用 html，不用本地组件', () => {
    render(
      <EventRenderer
        event={{
          type: 'caveat',
          text: '本地文本不该出现',
          html: '<p>服务端渲染的说明</p>',
        } as unknown as StreamEvent}
      />,
    );

    expect(screen.getByText('服务端渲染的说明')).toBeTruthy();
    expect(screen.queryByText('本地文本不该出现')).toBeNull();
  });
});
