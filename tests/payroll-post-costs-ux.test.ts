// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ post: vi.fn(), toast: vi.fn(), print: vi.fn() }));

vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: mock.toast }) }));

const payroll = [
  { id: 'pay1', worker_id: 'w1', project_id: 'site', period_start: '2026-11-17', period_end: '2026-11-23', gross_pay: 7420, bale_deduction: 2000, other_deductions: 0, net_pay: 5420, days_worked: 6, status: 'paid' },
  { id: 'pay2', worker_id: 'w2', project_id: 'site', period_start: '2026-11-17', period_end: '2026-11-23', gross_pay: 8250, bale_deduction: 0, other_deductions: 0, net_pay: 8250, days_worked: 7, status: 'paid' },
  { id: 'pay3', worker_id: 'w1', project_id: 'site', period_start: '2026-11-17', period_end: '2026-11-23', gross_pay: 5000, bale_deduction: 0, other_deductions: 0, net_pay: 5000, days_worked: 5, status: 'draft' },
];

vi.mock('@/lib/data/store', () => ({
  useDataStore: () => ({
    isLoaded: true,
    payroll,
    workers: [
      { id: 'w1', name: 'Ricardo Dela Cruz', position: 'Mason', active: true },
      { id: 'w2', name: 'Jose Mari Santos', position: 'Carpenter', active: true },
    ],
    projects: [
      { id: 'site', name: 'Villa Serena', location: 'Batangas, PH' },
      { id: 'other', name: 'Batangas Fit-out', location: 'Batangas, PH' },
    ],
    attendance: [],
    advances: [],
    createPayrollRun: vi.fn(),
    updatePayrollStatus: vi.fn(),
    postPayrollExpense: mock.post,
  }),
}));

import PayrollPage from '@/app/payroll/page';

beforeEach(() => {
  mock.post.mockReset();
  mock.toast.mockReset();
  window.history.replaceState({}, '', '/payroll');
});

afterEach(() => cleanup());

describe('payroll — posting a run to project costs', () => {
  it('scopes the page to the run named in the deep link and consumes it', async () => {
    window.history.replaceState(
      {},
      '',
      '/payroll?period_start=2026-11-17&period_end=2026-11-23&site=site'
    );
    render(React.createElement(PayrollPage));

    // Period and site came from the link, so the manual post opens on that site.
    fireEvent.click(screen.getByRole('button', { name: /Post to project costs/ }));
    const dialog = screen.getByRole('dialog', { name: /Post to project costs/ });

    expect(within(dialog).getByText('Period 2026-11-17 → 2026-11-23')).toBeTruthy();
    expect(within(dialog).getByText('2 of 3')).toBeTruthy();
    expect(within(dialog).getByText('₱15,670.00')).toBeTruthy();
    expect(within(dialog).getByText('−₱2,000.00')).toBeTruthy();
    expect(within(dialog).getByText('₱13,670.00')).toBeTruthy();

    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('posts the net released for the chosen site and reports what was written', async () => {
    window.history.replaceState({}, '', '/payroll?period_start=2026-11-17&period_end=2026-11-23&site=site');
    mock.post.mockResolvedValue({ outcome: 'created', amount: 13670, gross: 15670, bale_recovered: 2000, net_released: 13670, vouchers: 2 });
    render(React.createElement(PayrollPage));

    fireEvent.click(screen.getByRole('button', { name: /Post to project costs/ }));
    const dialog = screen.getByRole('dialog', { name: /Post to project costs/ });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /Post ₱13,670\.00/ }));
    });

    expect(mock.post).toHaveBeenCalledWith('site', '2026-11-17', '2026-11-23');
    expect(mock.toast).toHaveBeenCalledWith('success', '₱13,670.00 posted to Villa Serena as labor cost.');
  });

  it('refuses to post while no site is chosen and says why', () => {
    window.history.replaceState({}, '', '/payroll?period_start=2026-11-17&period_end=2026-11-23');
    render(React.createElement(PayrollPage));

    fireEvent.click(screen.getByRole('button', { name: /Post to project costs/ }));
    const dialog = screen.getByRole('dialog', { name: /Post to project costs/ });

    expect(within(dialog).getByText(/firm-wide run cannot post a cost/)).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Post to project costs' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mock.post).not.toHaveBeenCalled();
  });

  it('opens the 3×3 print dialog for the linked run only after data is loaded', async () => {
    window.history.replaceState(
      {},
      '',
      '/payroll?period_start=2026-11-17&period_end=2026-11-23&site=site&print=1'
    );
    render(React.createElement(PayrollPage));

    const dialog = await screen.findByRole('dialog', { name: /Print All Payroll Slips/ });
    expect(within(dialog).getByText(/3 payroll slips for Villa Serena/)).toBeTruthy();
    expect(within(dialog).getByText(/1 A4 page/)).toBeTruthy();
  });
});
