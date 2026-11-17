/* ------------------------------------------------------------------
 * 挂号页 —— 「从对话带推荐科室进来」这条路的三个硬要求：
 *
 *   1. 可切换：推荐给了几个科，就能在这几个里点着换（分诊本来也不是
 *      只有一个答案，让用户自己挑一个更合理）。
 *   2. 有边界：推荐之外的科不出现，避免"问诊说心血管、挂号挂内分泌"。
 *   3. 院区跟着科室变：只列真的开了这个科的院区，否则用户点进去看到
 *      "没放号"，会以为今天号满了，其实这家根本没这个科。
 *
 * 不测的：号源渲染、下单流程 —— 那些是原有逻辑，改动没碰。
 * ------------------------------------------------------------------ */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BookingPage from './BookingPage';
import * as api from '../lib/api';

const CATALOG = [
  {
    code: 'Z2-JFL',
    name: '解放路院区',
    departments: ['内分泌科', '心血管内科', '消化内科'],
  },
  {
    code: 'Z2-BJ',
    name: '滨江院区',
    departments: ['心血管内科', '骨科'],
  },
  {
    // 只开皮肤科 —— 切到皮肤科时，别的院区必须消失
    code: 'SKIN',
    name: '皮肤专科院区',
    departments: ['皮肤科'],
  },
];

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/booking${search}`]}>
      <BookingPage />
    </MemoryRouter>,
  );
}

/** 推荐参数形如 departments=心血管内科,消化内科 */
function recommendedParam(...names: string[]) {
  return encodeURIComponent(names.join(','));
}

beforeEach(() => {
  vi.spyOn(api, 'loadHospitalCatalog').mockResolvedValue({
    ok: true,
    data: CATALOG,
  } as never);
  vi.spyOn(api, 'getSlots').mockResolvedValue({
    ok: true,
    data: [
      {
        visitTime: '2026-11-18T08:30:00',
        doctorName: '演示医生A',
        remaining: 3,
      },
    ],
  } as never);
});

afterEach(() => {
  // 本项目没开 vitest globals，@testing-library 的自动清理不会生效，
  // 不手动 cleanup 的话上一个用例的 DOM 会留在页面里，断言就会
  // "找到多个元素" —— 这个坑本身值得留一行注释。
  cleanup();
  vi.restoreAllMocks();
});

describe('挂号页：带推荐科室进来', () => {
  it('推荐的科室都能点，推荐之外的科不出现', async () => {
    renderAt(
      `?department=心血管内科&hospital=Z2-JFL&departments=${recommendedParam('心血管内科', '消化内科')}`,
    );

    await waitFor(() => {
      expect(screen.getByText('选科室（问诊推荐）')).toBeTruthy();
    });

    // 两个推荐科室都在，而且是可以点的按钮
    const cardio = screen.getByRole('button', { name: '心血管内科' });
    const gastro = screen.getByRole('button', { name: '消化内科' });
    expect((cardio as HTMLButtonElement).disabled).toBe(false);
    expect((gastro as HTMLButtonElement).disabled).toBe(false);

    // 推荐之外的内分泌科、骨科按钮不存在
    expect(screen.queryByRole('button', { name: '内分泌科' })).toBeNull();
    expect(screen.queryByRole('button', { name: '骨科' })).toBeNull();
  });

  it('切换推荐科室后，院区列表跟着换成开了这个科的院区', async () => {
    renderAt(
      `?department=心血管内科&hospital=Z2-JFL&departments=${recommendedParam('心血管内科', '皮肤科')}`,
    );

    await waitFor(() => {
      expect(screen.getByText('解放路院区')).toBeTruthy();
    });
    // 心血管内科：解放路和滨江都开，皮肤专科院区不开
    expect(screen.getByText('滨江院区')).toBeTruthy();
    expect(screen.queryByText('皮肤专科院区')).toBeNull();

    // 切到皮肤科 → 只剩皮肤专科院区
    fireEvent.click(screen.getByRole('button', { name: '皮肤科' }));

    await waitFor(() => {
      expect(screen.getByText('皮肤专科院区')).toBeTruthy();
    });
    expect(screen.queryByText('滨江院区')).toBeNull();
    expect(screen.queryByText('解放路院区')).toBeNull();
  });

  it('推荐了但目录里没这个科 → 按钮置灰并标注暂不可约', async () => {
    renderAt(
      `?department=心血管内科&departments=${recommendedParam('心血管内科', '临床心理科')}`,
    );

    await waitFor(() => {
      expect(screen.getByText('选科室（问诊推荐）')).toBeTruthy();
    });

    const psych = screen.getByRole('button', { name: /临床心理科/ });
    expect((psych as HTMLButtonElement).disabled).toBe(true);
    expect(psych.textContent).toContain('暂不可约');
  });

  it('带进来的时段会被预选，确认区显示当前科室', async () => {
    renderAt(
      `?department=心血管内科&hospital=Z2-JFL&date=2026-11-18&slot=2026-11-18T08:30:00&departments=${recommendedParam('心血管内科', '消化内科')}`,
    );

    await waitFor(() => {
      expect(screen.getByText('确认挂号信息')).toBeTruthy();
    });

    expect(screen.getByText('08:30')).toBeTruthy();
    // 科室名会同时出现在选择区和确认区，所以用 getAllByText
    expect(screen.getAllByText('心血管内科').length).toBeGreaterThan(0);
  });
});

describe('挂号页：手动进来（没有参数）', () => {
  it('仍然可以按院区自由选科室', async () => {
    renderAt('');

    await waitFor(() => {
      expect(screen.getByText('选科室')).toBeTruthy();
    });

    expect(screen.getByRole('button', { name: '内分泌科' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '心血管内科' })).toBeTruthy();
  });
});
