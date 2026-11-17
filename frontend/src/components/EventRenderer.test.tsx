/* ------------------------------------------------------------------
 * 预约预览卡 —— 只盯一件事：卡片**不再直接下单**。
 *
 * 之前这里是「确认挂号」按钮，点了就调 POST /api/bookings 占号。
 * 问题是一个点错就无法回滚，而且用户没得选时段。现在改成「去挂号」，
 * 把人带到挂号页去挑时段再确认。这个测试就是防止有人把它改回去。
 * ------------------------------------------------------------------ */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { BookingPreviewCard } from './EventRenderer';

const PREORDER = {
  preorderId: 'Z2-JFL:心血管内科:2026-11-18T08:30:00',
  hospitalCode: 'Z2-JFL',
  hospital: '解放路院区',
  department: '心血管内科',
  doctor: '心血管内科 · 演示医生A',
  slot: '2026-11-18T08:30:00',
  holdExpiresAt: '',
};

function renderCard() {
  return render(
    <MemoryRouter>
      <BookingPreviewCard preorder={PREORDER} />
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe('预约预览卡', () => {
  it('按钮是「去挂号」，不再有直接下单的「确认挂号」', () => {
    renderCard();

    expect(screen.getByText('去挂号')).toBeTruthy();
    expect(screen.queryByText('确认挂号')).toBeNull();
    expect(screen.queryByText('正在预约…')).toBeNull();
  });

  it('跳转链接带上院区、科室、日期、时段', () => {
    renderCard();

    const link = screen.getByRole('link', { name: '去挂号' });
    const href = link.getAttribute('href') ?? '';

    expect(href.startsWith('/booking?')).toBe(true);
    expect(href).toContain('hospital=Z2-JFL');
    expect(href).toContain('department=' + encodeURIComponent('心血管内科'));
    expect(href).toContain('date=2026-11-18');
    expect(href).toContain('slot=' + encodeURIComponent('2026-11-18T08:30:00'));
  });

  it('带推荐科室时，链接里带上推荐列表（挂号页据此做可切换范围）', () => {
    render(
      <MemoryRouter>
        <BookingPreviewCard
          preorder={{
            ...PREORDER,
            departmentOptions: ['心血管内科', '消化内科'],
          }}
        />
      </MemoryRouter>,
    );

    const href = screen.getByRole('link', { name: '去挂号' }).getAttribute('href') ?? '';
    expect(href).toContain(
      'departments=' + encodeURIComponent('心血管内科,消化内科'),
    );
  });

  it('明说不占号，避免用户以为点了就约上了', () => {
    renderCard();
    expect(screen.getByText('到挂号页挑时段再确认，这里不会直接占号')).toBeTruthy();
  });
});
