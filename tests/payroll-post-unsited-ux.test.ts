// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ post: vi.fn(), toast: vi.fn() }));
const state = vi.hoisted(() => ({ payroll: [] as Array<Record<string, unknown>> }));

vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: mock.toast }) }));

const sitePaid = {
  id: 's1', worker_id: 'w1', project_id: 'site', period_start: '2026-11-17', period_end: '2026-11-23',
  gross_pay: 6000, bale_deduction: 1000, other_deductions: 0, net_pay: 5000, days_worked: 6, status: 'paid',
};
const siteDraft = {
  id: 's2', worker_id: 'w2', project_id: 'site', period_start: '2026-11-17', period_end: '2026-11-23',
  gross_pay: 3000, bale_deduction: 0, other_deductions: 0, net_pay: 3000, days_worked: 3, status: 'draft',
};
const unsitedPaid = {
  id: 'u1', worker_id: 'w3', project_id: null, period_start: '2026-11-17', period_end: '2026-11-23',
  gross_pay: 4000, bale_deduction: 0, other_deductions: 0, net_pay: 4000, days_worked: 4, status: 'paid',
};
// Same shape, different period: must never be swept into this run.
const unsitedOtherPeriod = {
  id: 'u2', worker_id: 'w3', project_id: null, period_start: '2026-12-01', period_end: '2026-12-15',
  gross_pay: 9999, bale_deduction: 0, other_deductions: 0, net_pay: 9999, days_worked: 9, status: 'paid',
};

vi.mock('@/lib/data/store', () => ({
  useDataStore: () => ({
    isLoaded: true,
    payroll: state.payroll,
    workers: [
      { id: 'w1', name: 'Ricardo Dela Cruz', position: 'Mason', active: true },
      { id: 'w2', name: 'Jose Mari Santos', position: 'Carpenter', active: true },
      { id: 'w3', name: 'Ana Dela Cruz', position: 'Helper', active: true },
    ],
    projects: [{ id: 'site', name: 'Villa Serena', location: 'Batangas, PH' }],
    attendance: [],
    advances: [],
    createPayrollRun: vi.fn(),
    updatePayrollStatus: vi.fn(),
    postPayrollExpense: mock.post,
  }),
}));

import PayrollPage from '@/app/payroll/page';

const openDialog = () => {
  fireEvent.click(screen.getByRole('button', { name: /Post to project costs/ }));
  return screen.getByRole('dialog', { name: /Post to project costs/ });
};

beforeEach(() => {
  mock.post.mockReset();
  mock.toast.mockReset();
  state.payroll = [sitePaid, siteDraft, unsitedPaid, unsitedOtherPeriod];
  window.history.replaceState({}, '', '/payroll?period_start=2026-11-17&period_end=2026-11-23&site=site');
});

afterEach(() => cleanup());

describe('posting pre-upgrade vouchers on purpose', () => {
  it('offers the opt-in, counts only this period, and keeps the default scope site-only', () => {
    render(React.createElement(PayrollPage));
    const dialog = openDialog();

    // One unsited voucher in this period (not the December one).
    expect(within(dialog).getByText('Include 1 paid voucher recorded before sites were tracked')).toBeTruthy();
    expect((within(dialog).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getByText('1 of 2')).toBeTruthy();
    expect(within(dialog).getByText('₱5,000.00')).toBeTruthy();
  });

  it('adds the pre-upgrade vouchers to the preview when opted in and posts the flag', async () => {
    mock.post.mockResolvedValue({ outcome: 'created', amount: 9000, gross: 10000, bale_recovered: 1000, net_released: 9000, vouchers: 2, unsited_vouchers: 1 });
    render(React.createElement(PayrollPage));
    const dialog = openDialog();

    fireEvent.click(within(dialog).getByRole('checkbox'));

    expect(within(dialog).getByText('2 of 3')).toBeTruthy();
    expect(within(dialog).getByText('₱10,000.00')).toBeTruthy();
    expect(within(dialog).getByText('−₱1,000.00')).toBeTruthy();
    expect(within(dialog).getByText('₱9,000.00')).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /Post ₱9,000\.00/ }));
    });

    expect(mock.post).toHaveBeenCalledWith('site', '2026-11-17', '2026-11-23', { includeUnsited: true });
    expect(mock.toast).toHaveBeenCalledWith(
      'success',
      '₱9,000.00 posted to Villa Serena as labor cost (includes 1 voucher recorded before sites were tracked).'
    );
  });

  it('does not offer the opt-in for approved vouchers and explains why nothing can post', () => {
    // Nothing is paid in this period: the site has only a draft, the pre-upgrade
    // voucher is approved.
    state.payroll = [siteDraft, { ...unsitedPaid, status: 'approved' }, unsitedOtherPeriod];
    render(React.createElement(PayrollPage));
    const dialog = openDialog();

    // Approved is not paid: no money has left, so there is nothing to include.
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(
      within(dialog).getByText(/This period has 1 voucher recorded before sites were tracked, but none are paid yet/)
    ).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Post to project costs' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('points at the opt-in when paid pre-upgrade vouchers exist but are not in scope', () => {
    state.payroll = [siteDraft, unsitedPaid];
    render(React.createElement(PayrollPage));
    const dialog = openDialog();

    expect(
      within(dialog).getByText(/1 paid voucher of this period was recorded before sites were tracked and is not in scope yet/)
    ).toBeTruthy();
  });

  it('hides the opt-in when every voucher of the period already knows its site', () => {
    state.payroll = [sitePaid, siteDraft];
    render(React.createElement(PayrollPage));
    const dialog = openDialog();

    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).getByText('1 of 2')).toBeTruthy();
  });
});
