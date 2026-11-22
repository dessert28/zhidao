/* ------------------------------------------------------------------
 * 工作台导航回归测试
 *
 * 这次重做要钉死的事：
 *   1. 品牌区回本工作台首页，不再把医生/管理员送到患者端
 *   2. 工作台里没有任何指向 "/" 的患者端入口
 *   3. 医生端三项、管理端分组五项导航齐全
 *   4. 角色守卫仍在（患者进不去两个工作台）
 *
 * 第 2 条是这次 bug 的根因：原外壳的品牌区写死 to="/" 带 stay 标记，
 * 点"医生工作台"那几个字却被送去患者端首页。
 * ------------------------------------------------------------------ */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminShell } from '../admin/AdminShell';
import { DoctorShell } from '../doctor/DoctorShell';

const ROLE_KEY = 'zhidao:role';

function renderShell(role: string, path: string, shell: 'admin' | 'doctor') {
  sessionStorage.setItem(ROLE_KEY, role);
  return render(
    <MemoryRouter initialEntries={[path]}>
      {shell === 'admin' ? (
        <AdminShell title="概览">后台内容</AdminShell>
      ) : (
        <DoctorShell title="患者工作台">医生内容</DoctorShell>
      )}
    </MemoryRouter>,
  );
}

/** 所有 href="/" 的链接 —— 患者端入口的标志 */
function patientSideLinks(): HTMLAnchorElement[] {
  return Array.from(document.querySelectorAll('a[href="/"]'));
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe('品牌区指向本工作台', () => {
  it('管理端品牌回 /admin，不是患者端', () => {
    renderShell('ADMIN', '/admin/users', 'admin');

    const brand = screen.getByRole('link', { name: '管理后台首页' });
    expect(brand.getAttribute('href')).toBe('/admin');
    expect(patientSideLinks()).toHaveLength(0);
  });

  it('医生端品牌回 /doctor，不是患者端', () => {
    renderShell('DOCTOR', '/doctor/brief', 'doctor');

    const brand = screen.getByRole('link', { name: '医生工作台首页' });
    expect(brand.getAttribute('href')).toBe('/doctor');
    expect(patientSideLinks()).toHaveLength(0);
  });

  it('管理员进医生端时品牌同样回 /doctor', () => {
    renderShell('ADMIN', '/doctor', 'doctor');

    expect(screen.getByRole('link', { name: '医生工作台首页' }).getAttribute('href')).toBe('/doctor');
    expect(patientSideLinks()).toHaveLength(0);
  });
});

describe('工作台不含患者端入口', () => {
  it('管理端五个模块页面都没有指向 "/" 的链接', () => {
    const paths = [
      '/admin',
      '/admin/users',
      '/admin/hospitals',
      '/admin/notices',
      '/admin/knowledge',
    ];
    for (const path of paths) {
      cleanup();
      renderShell('ADMIN', path, 'admin');
      expect(patientSideLinks(), `路径 ${path} 出现了患者端入口`).toHaveLength(0);
    }
  });

  it('医生端三页都没有指向 "/" 的链接', () => {
    for (const path of ['/doctor', '/doctor/brief', '/doctor/policy']) {
      cleanup();
      renderShell('DOCTOR', path, 'doctor');
      expect(patientSideLinks(), `路径 ${path} 出现了患者端入口`).toHaveLength(0);
    }
  });
});

describe('导航项齐全', () => {
  it('医生端侧栏三项都在', () => {
    renderShell('DOCTOR', '/doctor', 'doctor');

    for (const label of ['患者工作台', '预问诊摘要', '工作边界']) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0);
    }
  });

  it('管理端五个模块都在，且当前项标记 aria-current', () => {
    renderShell('ADMIN', '/admin/users', 'admin');

    for (const label of ['概览', '用户', '院区与科室', '公告', '导诊知识库']) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0);
    }
    const current = screen.getAllByRole('link', { name: '用户', current: 'page' });
    expect(current.length).toBeGreaterThan(0);
  });

  it('医生端当前项高亮跟随路径', () => {
    renderShell('DOCTOR', '/doctor/policy', 'doctor');

    const current = screen.getAllByRole('link', { name: '工作边界', current: 'page' });
    expect(current.length).toBeGreaterThan(0);
  });
});

describe('角色守卫', () => {
  it('患者看不到管理后台内容', () => {
    renderShell('PATIENT', '/admin', 'admin');

    expect(screen.getByText('需要管理员权限')).toBeTruthy();
    expect(screen.queryByText('后台内容')).toBeNull();
    expect(patientSideLinks()).toHaveLength(0);
  });

  it('患者看不到医生工作台内容', () => {
    renderShell('PATIENT', '/doctor', 'doctor');

    expect(screen.getByText('这里是医生工作台')).toBeTruthy();
    expect(screen.queryByText('医生内容')).toBeNull();
    expect(patientSideLinks()).toHaveLength(0);
  });
});
