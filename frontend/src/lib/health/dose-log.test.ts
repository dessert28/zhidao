import { beforeEach, describe, expect, it } from 'vitest';
import {
  KEEP_DAYS,
  getDayStatus,
  pruneLog,
  readDoseLog,
  setDoseStatus,
  summarizeProgress,
  todayStr,
  writeDoseLog,
  type DoseLog,
} from './dose-log';

beforeEach(() => {
  localStorage.clear();
});

describe('服药记录', () => {
  it('记下已服用 / 已跳过', () => {
    let log = setDoseStatus({}, '2026-11-16', '每日 08:30', 'taken');
    log = setDoseStatus(log, '2026-11-16', '每日 睡前', 'skipped');
    expect(getDayStatus(log, '2026-11-16')).toEqual({
      '每日 08:30': 'taken',
      '每日 睡前': 'skipped',
    });
  });

  it('再点一次是取消 —— 不额外加一个"撤销"按钮', () => {
    const log = setDoseStatus({}, '2026-11-16', '每日 08:30', 'taken');
    const cleared = setDoseStatus(log, '2026-11-16', '每日 08:30', null);
    expect(getDayStatus(cleared, '2026-11-16')).toEqual({});
  });

  it('不同的日子互不影响', () => {
    let log = setDoseStatus({}, '2026-11-15', '每日 08:30', 'taken');
    log = setDoseStatus(log, '2026-11-16', '每日 08:30', 'skipped');
    expect(getDayStatus(log, '2026-11-15')['每日 08:30']).toBe('taken');
    expect(getDayStatus(log, '2026-11-16')['每日 08:30']).toBe('skipped');
  });

  it('没有记录不等于"没吃" —— 只能读出空', () => {
    const log = setDoseStatus({}, '2026-11-16', '每日 08:30', 'taken');
    expect(getDayStatus(log, '2026-11-16')['每日 20:00']).toBeUndefined();
  });
});

describe('过期清理', () => {
  it('保留最近 KEEP_DAYS 天，更早的删掉', () => {
    const log: DoseLog = {
      '2026-11-16': { a: 'taken' },
      '2026-11-01': { b: 'taken' }, // 15 天前，保留
      '2026-09-01': { c: 'taken' }, // 两个多月前，该删
    };
    const pruned = pruneLog(log, '2026-11-16');
    expect(Object.keys(pruned).sort()).toEqual(['2026-11-01', '2026-11-16']);
  });

  it('未来的日期也清掉（时区或系统时间错乱时不至于堆积）', () => {
    const pruned = pruneLog({ '2027-01-01': { a: 'taken' } }, '2026-11-16');
    expect(pruned).toEqual({});
  });

  it('保留窗口边界', () => {
    const out = pruneLog({ '2026-10-18': { a: 'taken' } }, '2026-11-16');
    // 11-16 往回数 KEEP_DAYS-1 天 = 10-18，正好在窗口内
    expect(Object.keys(out)).toEqual(['2026-10-18']);
    expect(KEEP_DAYS).toBe(30);
  });
});

describe('存取', () => {
  it('写进去读出来一致', () => {
    const log = setDoseStatus({}, '2026-11-16', '每日 08:30', 'taken');
    writeDoseLog(log, '2026-11-16');
    expect(readDoseLog()).toEqual(log);
  });

  it('数据坏了就当空，不让整页崩', () => {
    localStorage.setItem('zhidao.dose-log.v1', '{不是 JSON');
    expect(readDoseLog()).toEqual({});
    localStorage.setItem('zhidao.dose-log.v1', '[1,2,3]');
    expect(readDoseLog()).toEqual({});
  });
});

describe('本地日期', () => {
  it('不用 UTC —— 晚上 8 点后不能算成明天', () => {
    const late = new Date('2026-11-16T23:30:00');
    expect(todayStr(late)).toBe('2026-11-16');
  });
});

describe('完成情况', () => {
  const ids = ['每日 08:30', '每日 13:00', '每日 20:30'];

  it('一条都没记录时不说"漏服"', () => {
    const s = summarizeProgress(ids, {});
    expect(s.text).not.toContain('漏');
    expect(s.text).not.toContain('没吃');
    expect(s.taken).toBe(0);
  });

  it('统计已记录与剩余', () => {
    const s = summarizeProgress(ids, { '每日 08:30': 'taken', '每日 13:00': 'skipped' });
    expect(s.taken).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.text).toContain('已记录 1 档');
    expect(s.text).toContain('跳过 1 档');
    expect(s.text).toContain('还有 1 档没记录');
  });

  it('空时间表不给句子', () => {
    expect(summarizeProgress([], {}).text).toBe('');
  });
});
