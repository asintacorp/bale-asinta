// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ toast: vi.fn(), load: vi.fn(), save: vi.fn(), remove: vi.fn() }));

vi.mock('@/components/layout/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ showToast: mock.toast }) }));
vi.mock('@/lib/auth/authContext', () => ({
  useAuth: () => ({ user: { id: 'founder' }, isFounder: true, assurance: 'ready', isLoading: false }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        upload: vi.fn(),
        createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/photo' }, error: null }),
      }),
    },
  }),
}));
vi.mock('@/lib/expenses/draftStore', () => ({
  loadExpenseDraft: mock.load,
  saveExpenseDraft: mock.save,
  deleteExpenseDraft: mock.remove,
}));

const expenses = [
  {
    id: 'e1', project_id: 'site', description: 'Cement — 60 bags (Holcim)', category: 'materials',
    amount: 18450, expense_date: '2026-11-20', revision: 0,
  },
  {
    id: 'e2', project_id: 'site', description: 'Cash advance — Ricardo Dela Cruz', category: 'labor',
    amount: 2000, expense_date: '2026-11-12', revision: 0,
    source: 'advance', advance_id: 'a1', notes: 'School fees',
  },
  {
    id: 'e3', project_id: 'site', description: 'Payroll — Villa Serena Residence', category: 'labor',
    amount: 13670, expense_date: '2026-11-23', revision: 0,
    source: 'payroll', payroll_period_start: '2026-11-17', payroll_period_end: '2026-11-23',
    notes: 'Generated from paid payroll vouchers. Amount, project, date and category are locked to payroll.',
  },
];

const payroll = [
  {
    id: 'pay1', worker_id: 'w1', project_id: 'site', period_start: '2026-11-17', period_end: '2026-11-23',
    gross_pay: 7420, bale_deduction: 2000, other_deductions: 0, net_pay: 5420, days_worked: 6, status: 'paid',
  },
  {
    id: 'pay2', worker_id: 'w2', project_id: 'site', period_start: '2026-11-17', period_end: '2026-11-23',
    gross_pay: 8250, bale_deduction: 0, other_deductions: 0, net_pay: 8250, days_worked: 7, status: 'paid',
  },
];

vi.mock('@/lib/data/store', () => ({
  useDataStore: () => ({
    isLoaded: true,
    expenses,
    payroll,
    advances: [
      { id: 'a1', worker_id: 'w1', project_id: 'site', amount: 2000, amount_deducted: 2000, status: 'fully_deducted', date: '2026-11-12', reason: 'School fees' },
    ],
    workers: [
      { id: 'w1', name: 'Ricardo Dela Cruz', position: 'Mason', active: true },
      { id: 'w2', name: 'Jose Mari Santos', position: 'Carpenter', active: true },
    ],
    projects: [{ id: 'site', name: 'Villa Serena Residence', location: 'Batangas, PH' }],
    createExpense: vi.fn(),
    updateExpense: vi.fn(),
    deleteExpense: vi.fn(),
    createAdvance: vi.fn(),
  }),
}));

import ExpensesPage from '@/app/expenses/page';

afterEach(() => cleanup());

const rowFor = (text: string | RegExp) => screen.getByText(text).closest('div[class*="p-4"]') as HTMLElement;

describe('expenses ledger — posted payroll and advance costs', () => {
  it('totals the filtered view and splits labor by where it came from', () => {
    mock.load.mockResolvedValue({ ok: true, value: null });
    render(React.createElement(ExpensesPage));

    const strip = screen.getByRole('region', { name: 'Totals for the expenses in this view' });
    expect(within(strip).getByText('3 expenses')).toBeTruthy();
    expect(within(strip).getByText('in this view')).toBeTruthy();
    expect(within(strip).getByText('₱34,120.00')).toBeTruthy();
    expect(within(strip).getByText(/Labor ₱15,670\.00/)).toBeTruthy();
    expect(within(strip).getByText('= advances ₱2,000.00 + payroll ₱13,670.00')).toBeTruthy();

    // The strip follows the filters, so money and count never disagree.
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'labor' } });
    const laborOnly = screen.getByRole('region', { name: 'Totals for the expenses in this view' });
    expect(within(laborOnly).getByText('2 expenses')).toBeTruthy();
    expect(within(laborOnly).getByText('₱15,670.00')).toBeTruthy();
  });

  it('states payroll arithmetic as gross − bale recovered = net and links to the run', () => {
    mock.load.mockResolvedValue({ ok: true, value: null });
    render(React.createElement(ExpensesPage));

    const row = rowFor('Payroll — Villa Serena Residence');
    expect(within(row).getByText('From payroll')).toBeTruthy();
    expect(within(row).getByText('Auto-posted on release')).toBeTruthy();
    expect(
      within(row).getByText(/Gross ₱15,670\.00 − Bale recovered ₱2,000\.00 = Net released ₱13,670\.00/)
    ).toBeTruthy();
    expect(within(row).getByText(/2 of 2 vouchers paid/)).toBeTruthy();

    const print = within(row).getByRole('link', { name: /Print payslips/ });
    expect(print.getAttribute('href')).toBe(
      '/payroll?period_start=2026-11-17&period_end=2026-11-23&site=site&print=1'
    );
    // Generated rows are locked to their source: no Delete.
    expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(row).getByText('Locked — managed by payroll')).toBeTruthy();
  });

  it('shows an advance as released cash with recovery, not a second cost', () => {
    mock.load.mockResolvedValue({ ok: true, value: null });
    render(React.createElement(ExpensesPage));

    const row = rowFor('Cash advance — Ricardo Dela Cruz');
    expect(within(row).getByText('From advance')).toBeTruthy();
    expect(within(row).getByText('Auto-posted on issue')).toBeTruthy();
    expect(within(row).getByText('Ricardo Dela Cruz')).toBeTruthy();
    expect(row.textContent).toContain('Worker:');
    expect(within(row).getByText(/₱2,000\.00 of ₱2,000\.00 recovered through payroll Bale deductions/)).toBeTruthy();
    expect(within(row).getByRole('link', { name: /Open advance/ }).getAttribute('href')).toBe('/advances?tab=issued');
    expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('keeps Delete on typed entries only', () => {
    mock.load.mockResolvedValue({ ok: true, value: null });
    render(React.createElement(ExpensesPage));

    expect(within(rowFor('Cement — 60 bags (Holcim)')).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
  });

  it('opens the payroll expense with the worker breakdown and the two slab actions', () => {
    mock.load.mockResolvedValue({ ok: true, value: null });
    render(React.createElement(ExpensesPage));

    fireEvent.click(within(rowFor('Payroll — Villa Serena Residence')).getByRole('button', { name: 'View details' }));
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).getByText('Locked')).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'Workers paid' })).toBeTruthy();
    expect(within(dialog).getByText('2 of 2')).toBeTruthy();
    expect(within(dialog).getByText('Total (locked to payroll)')).toBeTruthy();
    // Bale is shown as a recovery, and only where there was one.
    // Once on Ricardo's row, once on the total row.
    expect(within(dialog).getAllByText('−₱2,000.00')).toHaveLength(2);
    expect(within(dialog).getAllByText('—').length).toBeGreaterThan(0);

    expect(within(dialog).getByRole('link', { name: 'Print payslips (3×3)' }).getAttribute('href')).toBe(
      '/payroll?period_start=2026-11-17&period_end=2026-11-23&site=site&print=1'
    );
    expect(within(dialog).getByRole('link', { name: 'Open payroll run' }).getAttribute('href')).toBe(
      '/payroll?period_start=2026-11-17&period_end=2026-11-23&site=site'
    );
    expect(within(dialog).getByRole('button', { name: 'Edit title or notes' })).toBeTruthy();
  });
});
