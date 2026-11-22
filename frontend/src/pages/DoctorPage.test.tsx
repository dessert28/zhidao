/* ------------------------------------------------------------------
 * 医生工作台 —— 只测「改错了会直接影响诊疗判断」的四类逻辑：
 *
 *   1. 防抖：敲关键字不能每字一请求（后到的旧结果会让列表闪回）
 *   2. 错帧：切到 B 后，A 的详情即使后到也不能挂到 B 名下
 *   3. 空值口径：没记录就说没记录，不能留白让人读成"确认没有"
 *   4. 截断口径：10 条是"最近"，不是全部
 *
 * 顺带钉住分页参数与失败重试。不测视觉布局 —— 那是 DoctorShell 的事。
 *
 * 本项目未装 @testing-library/jest-dom、未开 vitest globals，
 * 所以手动 cleanup、用原生断言，写法对齐 BookingPage.test.tsx。
 * ------------------------------------------------------------------ */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DoctorPage from './DoctorPage';
import * as api from '../lib/api';

type Row = api.DoctorPatientRow;
type Detail = api.DoctorPatientDetail;
type ListResult = Awaited<ReturnType<typeof api.listDoctorPatients>>;
type DetailResult = Awaited<ReturnType<typeof api.getDoctorPatientDetail>>;

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    userId: 1,
    displayName: '张三',
    gender: 'M',
    age: 30,
    allergies: ['青霉素'],
    chronics: ['高血压'],
    medications: ['氨氯地平'],
    recordCount: 12,
    bookingCount: 1,
    lastVisitDate: '2026-11-01',
    ...overrides,
  };
}

function makeDetail(overrides: Partial<Detail> = {}): Detail {
  return {
    ...makeRow(),
    records: [
      {
        id: 101,
        visitDate: '2026-11-01',
        hospitalCode: 'Z2-JFL',
        department: '心血管内科',
        diagnosisBrief: '高血压复诊',
      },
    ],
    bookings: [
      {
        id: 201,
        visitTime: '2026-11-20T09:30:00',
        department: '心血管内科',
        status: 'CONFIRMED',
      },
    ],
    ...overrides,
  };
}

function listOk(rows: Row[], total = rows.length): ListResult {
  return { ok: true, data: { records: rows, total, page: 1, size: 20 } } as ListResult;
}

function detailOk(data: Detail): DetailResult {
  return { ok: true, data } as DetailResult;
}

function renderPage() {
  return render(
    <MemoryRouter>
      <DoctorPage />
    </MemoryRouter>,
  );
}

/** 可控 Promise：用来制造「A 的详情后到」这个真正的错帧场景 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.spyOn(api, 'currentRole').mockReturnValue('DOCTOR' as never);
  vi.spyOn(api, 'listDoctorPatients').mockResolvedValue(listOk([makeRow()]));
  vi.spyOn(api, 'getDoctorPatientDetail').mockResolvedValue(detailOk(makeDetail()));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('医生工作台：取数时序', () => {
  it('连打关键字只在停下 300ms 后发一次请求，参数带页码和页大小', async () => {
    vi.useFakeTimers();
    renderPage();

    // 先放掉首次加载的定时器，否则它会混进调用计数
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    vi.mocked(api.listDoctorPatients).mockClear();

    fireEvent.change(screen.getByRole('searchbox', { name: '按姓名或手机号搜索患者' }), {
      target: { value: '张' },
    });
    fireEvent.change(screen.getByRole('searchbox', { name: '按姓名或手机号搜索患者' }), {
      target: { value: '张三' },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(api.listDoctorPatients).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.listDoctorPatients).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.listDoctorPatients).mock.calls[0]![0]).toEqual({
      keyword: '张三',
      page: 1,
      size: 20,
    });
  });

  it('列表读不到时给重试入口，重试后能恢复', async () => {
    vi.mocked(api.listDoctorPatients)
      .mockResolvedValueOnce({ ok: false, failure: { code: 500, message: '后端开小差' } } as never)
      .mockResolvedValueOnce(listOk([makeRow()]));

    renderPage();

    expect(await screen.findByText('读不到患者列表')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByText('张三')).toBeTruthy();
    expect(api.listDoctorPatients).toHaveBeenCalledTimes(2);
  });

  it('超过一页才显示页码；翻页清空选中，不让右栏挂着别页患者的病历', async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      makeRow({ userId: i + 1, displayName: `第${i + 1}位` }),
    );
    vi.mocked(api.listDoctorPatients).mockResolvedValue(listOk(rows, 25));

    renderPage();

    expect(await screen.findByText('第 1 / 2 页 · 共 25 位')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /第1位/ }));
    expect((await screen.findAllByText('高血压复诊')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    // 选中被清空，右栏回到空态
    expect(screen.getByText('从左侧选择一位患者，这里显示授权范围内的就诊资料。')).toBeTruthy();
    await waitFor(() => {
      const last = vi.mocked(api.listDoctorPatients).mock.calls.at(-1)?.[0];
      expect(last?.page).toBe(2);
    });
  });
});

describe('医生工作台：病历归属与口径', () => {
  it('切到 B 后，A 后到的详情不会挂到 B 名下', async () => {
    const a = deferred<DetailResult>();
    const b = deferred<DetailResult>();
    vi.mocked(api.getDoctorPatientDetail)
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce(() => b.promise);
    vi.mocked(api.listDoctorPatients).mockResolvedValue(
      listOk([
        makeRow({ userId: 1, displayName: '甲患者' }),
        makeRow({ userId: 2, displayName: '乙患者' }),
      ]),
    );

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /甲患者/ }));
    // A 还没回来就切走 —— effect 的 cleanup 必须让 A 的结果作废
    fireEvent.click(screen.getByRole('button', { name: /乙患者/ }));

    const aRecord = makeDetail({ records: [{ ...makeDetail().records[0]!, diagnosisBrief: '甲患者的诊断' }] });
    await act(async () => {
      a.resolve(detailOk(aRecord));
    });
    // jsdom 不做媒体查询，宽屏右栏和窄屏内联两处都会渲染，所以用 queryAll
    expect(screen.queryAllByText('甲患者的诊断')).toHaveLength(0);

    const bRecord = makeDetail({ records: [{ ...makeDetail().records[0]!, diagnosisBrief: '乙患者的诊断' }] });
    await act(async () => {
      b.resolve(detailOk(bRecord));
    });
    expect((await screen.findAllByText('乙患者的诊断')).length).toBeGreaterThan(0);
  });

  it('姓名/性别/年龄缺失时照实说，过敏等空项写「未记录」不写空白', async () => {
    const empty = makeDetail({
      displayName: null,
      gender: null,
      age: null,
      allergies: [],
      chronics: [],
      medications: [],
    });
    vi.mocked(api.listDoctorPatients).mockResolvedValue(
      listOk([makeRow({ displayName: null, gender: null, age: null })]),
    );
    vi.mocked(api.getDoctorPatientDetail).mockResolvedValue(detailOk(empty));

    renderPage();

    // 列表行：编号是真实的，不能编一个名字
    expect(await screen.findByText('患者 #1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /患者 #1/ }));

    expect(await screen.findByText('性别未记录 · 年龄未记录')).toBeTruthy();
    // 过敏、慢病、在用药、性别、年龄共五处
    expect(screen.getAllByText('未记录').length).toBeGreaterThanOrEqual(3);
  });

  it('详情只给最近 10 条时，标题写清「最近 / 共」，不把截断当全部', async () => {
    const records = Array.from({ length: 10 }, (_, i) => ({
      ...makeDetail().records[0]!,
      id: 100 + i,
      diagnosisBrief: `第${i + 1}次就诊`,
    }));
    vi.mocked(api.getDoctorPatientDetail).mockResolvedValue(
      detailOk(makeDetail({ records, recordCount: 23, bookings: [], bookingCount: 0 })),
    );

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /张三/ }));

    expect((await screen.findAllByText('最近 10 条 / 共 23 条')).length).toBeGreaterThan(0);
    // 没被截断的那一组仍写简单条数，不啰嗦
    expect(screen.getAllByText('0 条').length).toBeGreaterThan(0);
    expect(screen.queryByText('10 条')).toBeNull();
  });

  it('未知预约状态原样显示，不猜成「已完成」', async () => {
    vi.mocked(api.getDoctorPatientDetail).mockResolvedValue(
      detailOk(makeDetail({ bookings: [{ ...makeDetail().bookings[0]!, status: 'PENDING_REVIEW' }] })),
    );

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /张三/ }));

    expect((await screen.findAllByText('PENDING_REVIEW')).length).toBeGreaterThan(0);
    expect(screen.queryByText('已完成')).toBeNull();
  });
});
