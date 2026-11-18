/* ------------------------------------------------------------------
 * 报告解读区块 —— 盯的是「只解释术语，不判断结果」这条线
 *
 * 三件事必须有测试守着：
 *   1. 结论原文照录，不出现任何我们改写过的判断句
 *   2. 术语注解确实把词翻成了白话（含区间去重后的结果）
 *   3. 模型补词是「点了才调」，失败也只是退回词库，不能变成报错界面
 * ------------------------------------------------------------------ */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportSection } from './ReportSection';
import type { MedicalRecord } from '../lib/api';

function record(over: Partial<MedicalRecord>): MedicalRecord {
  return {
    id: 1,
    hospitalCode: 'Z2-JFL',
    department: '呼吸内科',
    visitDate: '2026-11-01',
    diagnosisBrief: null,
    ocrText: '',
    fileName: null,
    source: 'upload',
    ...over,
  };
}

const CT = record({
  ocrText:
    '胸部 CT 平扫\n检查所见：\n双肺纹理清晰，纵隔居中，左肺上叶见磨玻璃结节，直径约 4mm。\n' +
    '检查结论：\n1. 左肺上叶磨玻璃结节，建议 3-6 个月复查。',
  fileName: 'CT报告.jpg',
});

const LAB = record({
  id: 2,
  department: '心血管内科',
  ocrText: [
    '检查名称：血常规',
    '姓名：张三  性别：男',
    '白细胞计数 6.2 10^9/L（参考范围 3.5-9.5）',
    '血红蛋白 128 g/L（参考范围 130-175）',
  ].join('\n'),
  fileName: '血常规.pdf',
});

function renderSection(records: MedicalRecord[]) {
  return render(
    <MemoryRouter>
      <ReportSection records={records} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('报告解读区块', () => {
  it('影像报告：照录结论，并把术语翻成白话', () => {
    renderSection([CT]);

    expect(screen.getByText(/报告解读/)).toBeTruthy();
    // 结论原文一字不改
    expect(screen.getByText(/建议 3-6 个月复查/)).toBeTruthy();
    // 术语注解
    expect(screen.getByText('磨玻璃密度影')).toBeTruthy();
    expect(screen.getByText(/像磨砂玻璃一样的影子/)).toBeTruthy();
  });

  it('脚注常驻，说明这不是诊断', () => {
    renderSection([CT]);
    expect(screen.getByText(/不涉及对结果的判断/)).toBeTruthy();
  });

  it('化验单直接列出数值，并标出超出参考范围的项', () => {
    renderSection([LAB]);

    // 没有部位的标题直接用类型名，不再重复挂类型标签
    expect(screen.getByText('化验单')).toBeTruthy();
    // 报告里的数值一项不落地摆出来，而不是让人去别处看
    expect(screen.getByText('白细胞计数')).toBeTruthy();
    expect(screen.getByText('6.2')).toBeTruthy();
    expect(screen.getByText('血红蛋白')).toBeTruthy();
    expect(screen.getByText('↓ 低于范围')).toBeTruthy();
    expect(screen.getByText(/共 2 项 · 1 项超出参考范围/)).toBeTruthy();
    // 原文随时可查，且仍能去健康管家看时间上的变化
    expect(screen.getByText('查看报告原文')).toBeTruthy();
    expect(screen.getByRole('link', { name: '健康管家' })).toBeTruthy();
  });

  it('读不出数值时说是原文可看，而不是空着', () => {
    renderSection([
      record({
        id: 3,
        ocrText: '检查名称：血常规\n检查所见：标本轻度溶血，建议重新采血。',
        fileName: '血常规.pdf',
      }),
    ]);

    expect(screen.getByText(/没能从这份报告里自动读出数值条目/)).toBeTruthy();
    expect(screen.getByText('查看报告原文')).toBeTruthy();
  });

  it('门诊病历不占这个区块的位置', () => {
    const { container } = renderSection([
      record({ ocrText: '主诉：咳嗽三天。现病史：三天前受凉后咳嗽。' }),
    ]);
    expect(container.textContent).toBe('');
  });

  it('带处方的门诊记录也不会变成「化验单」', () => {
    const { container } = renderSection([
      record({
        id: 5,
        ocrText: '血压 152/94 mmHg，空腹血糖 7.6 mmol/L。\n处方：\n二甲双胍缓释片 0.5g 每日2次',
      }),
    ]);
    expect(container.textContent).toBe('');
  });

  it('点「让 AI 补充术语」才请求，且补出来的词单独标注', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        terms: [{ term: '纵隔', explanation: '两肺之间、胸骨后方的那片区域，里面有心脏和大血管。' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderSection([CT]);
    expect(fetchMock).not.toHaveBeenCalled();

    screen.getByText('让 AI 补充没收录的术语').click();

    await waitFor(() => expect(screen.getByText(/AI 补/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.text).toContain('磨玻璃结节');
    // 已注解过的词要带上去重，避免模型重复解释
    expect(body.known).toContain('磨玻璃密度影');
  });

  it('模型不可用：只提示一句，界面照常显示词库注解', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: false, reason: 'no_model', message: '未配置模型，当前只用内置词库' }),
      }),
    );

    renderSection([CT]);
    screen.getByText('让 AI 补充没收录的术语').click();

    await waitFor(() => expect(screen.getByText('未配置模型，当前只用内置词库')).toBeTruthy());
    // 词库注解没有因为模型不可用而消失
    expect(screen.getByText('磨玻璃密度影')).toBeTruthy();
  });
});
