import { describe, expect, it } from 'vitest';
import type { Expense, Payroll } from '@/types';
import {
  advanceExpenseHref,
  expenseSourceOf,
  formatPeriodLabel,
  isLinkedExpense,
  payrollExpenseHref,
  payrollRunBreakdown,
  summarizeExpenses,
} from '@/lib/expenses/posting';

const makeExpense = (patch: Partial<Expense> = {}): Expense => ({
  id: 'e',
  project_id: 'site',
  description: 'x',
  category: 'materials',
  amount: 100,
  expense_date: '2026-11-20',
  receipt_url: null,
  notes: null,
  ai_category_suggestion: null,
  ai_bale_detection: false,
  ai_confirmed: false,
  created_by: 'founder',
  created_at: '2026-11-20T00:00:00.000Z',
  revision: 0,
  ...patch,
});

const makePayroll = (patch: Partial<Payroll> = {}): Payroll => ({
  id: 'p',
  worker_id: 'w1',
  project_id: 'site',
  period_start: '2026-11-17',
  period_end: '2026-11-23',
  gross_pay: 0,
  bale_deduction: 0,
  other_deductions: 0,
  net_pay: 0,
  status: 'paid',
  days_worked: 1,
  created_at: '2026-11-23T00:00:00.000Z',
  ...patch,
});

const base = makeExpense();

describe('expense posting helpers', () => {
  it('treats rows without a source as typed entries', () => {
    expect(expenseSourceOf(base)).toBe('manual');
    expect(isLinkedExpense(base)).toBe(false);
    expect(isLinkedExpense({ source: 'payroll' })).toBe(true);
    expect(isLinkedExpense({ source: 'advance' })).toBe(true);
  });

  it('totals the view and separates labor by where it came from', () => {
    const totals = summarizeExpenses([
      makeExpense({ amount: 18450 }),
      makeExpense({ id: 'a', amount: 2000, category: 'labor', source: 'advance' }),
      makeExpense({ id: 'p', amount: 13670.5, category: 'labor', source: 'payroll' }),
      makeExpense({ id: 'm', amount: 500, category: 'labor' }),
    ]);

    expect(totals.count).toBe(4);
    expect(totals.total).toBe(34620.5);
    expect(totals.labor).toBe(16170.5);
    expect(totals.advanceLabor).toBe(2000);
    expect(totals.payrollLabor).toBe(13670.5);
    expect(totals.manualLabor).toBe(500);
  });

  it('only counts paid vouchers of the same site and period', () => {
    const payroll = [
      makePayroll({ id: '1', gross_pay: 7420, bale_deduction: 2000, net_pay: 5420, days_worked: 6 }),
      makePayroll({ id: '2', worker_id: 'w2', gross_pay: 8250, net_pay: 8250, days_worked: 7 }),
      makePayroll({ id: '3', gross_pay: 5000, net_pay: 5000, days_worked: 5, status: 'draft' }),
      makePayroll({ id: '4', project_id: 'other', gross_pay: 1000, net_pay: 1000 }),
    ];
    const workers = [
      { id: 'w1', name: 'Ricardo Dela Cruz' },
      { id: 'w2', name: 'Jose Mari Santos' },
    ];

    const run = payrollRunBreakdown(payroll, workers, {
      source: 'payroll', project_id: 'site',
      payroll_period_start: '2026-11-17', payroll_period_end: '2026-11-23',
    });

    expect(run.paidVouchers).toBe(2);
    expect(run.totalVouchers).toBe(3);
    expect(run.gross).toBe(15670);
    expect(run.bale).toBe(2000);
    expect(run.net).toBe(13670);
    // Sorted by worker name, so the list reads like a payslip run.
    expect(run.rows.map((row) => row.workerName)).toEqual(['Jose Mari Santos', 'Ricardo Dela Cruz']);
  });

  it('returns an empty breakdown for rows that are not from payroll', () => {
    const run = payrollRunBreakdown([], [], { source: 'advance', project_id: 'site' });
    expect(run.rows).toEqual([]);
    expect(run.net).toBe(0);
  });

  it('links back to the run, with the print dialog only when asked', () => {
    const expense = makeExpense({
      source: 'payroll',
      payroll_period_start: '2026-11-17',
      payroll_period_end: '2026-11-23',
    });
    expect(payrollExpenseHref(expense)).toBe('/payroll?period_start=2026-11-17&period_end=2026-11-23&site=site');
    expect(payrollExpenseHref(expense, { print: true })).toContain('&print=1');
    expect(payrollExpenseHref(makeExpense({ source: 'advance' }))).toBeNull();
    expect(payrollExpenseHref({ ...expense, payroll_period_start: null })).toBeNull();
    expect(advanceExpenseHref()).toBe('/advances?tab=issued');
  });

  it('formats a period, collapsing a single day', () => {
    expect(formatPeriodLabel('2026-11-17', '2026-11-23')).toBe('2026-11-17 → 2026-11-23');
    expect(formatPeriodLabel('2026-11-17', '2026-11-17')).toBe('2026-11-17');
    expect(formatPeriodLabel(null, '2026-11-17')).toBeNull();
  });
});
