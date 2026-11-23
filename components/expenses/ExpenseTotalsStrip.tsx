'use client';

import React from 'react';
import { formatPeso } from '@/lib/email/format';
import type { ExpenseTotals } from '@/lib/expenses/posting';

/**
 * Totals for whatever the filters currently show — the same rows counted by the
 * "N expenses" text, so the money and the count never disagree.
 *
 * Labor is split by where it came from because that is where the double-counting
 * risk lives: an advance is posted when it is released, and the payroll run only
 * posts the net that is left after Bale recovery.
 */
export function ExpenseTotalsStrip({ totals }: { totals: ExpenseTotals }) {
  const sources: string[] = [];
  if (totals.advanceLabor > 0) sources.push(`advances ${formatPeso(totals.advanceLabor)}`);
  if (totals.payrollLabor > 0) sources.push(`payroll ${formatPeso(totals.payrollLabor)}`);
  if (totals.manualLabor > 0) sources.push(`entered by hand ${formatPeso(totals.manualLabor)}`);

  return (
    <section
      aria-label="Totals for the expenses in this view"
      className="rounded-xl border border-surface-border bg-white px-4 py-3 sm:px-5 sm:py-4"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-6">
        <div>
          <p className="text-sm font-bold tabular-nums text-navy">
            {totals.count} {totals.count === 1 ? 'expense' : 'expenses'}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-secondary">in this view</p>
        </div>

        <div>
          <p className="text-lg font-extrabold tabular-nums text-navy">{formatPeso(totals.total)}</p>
          <p className="mt-0.5 text-[11px] text-ink-secondary">total disbursed</p>
        </div>

        <div>
          <p className="text-sm font-bold tabular-nums text-navy">Labor {formatPeso(totals.labor)}</p>
          <p className="mt-0.5 break-words text-[11px] text-ink-secondary">
            {sources.length > 0 ? `= ${sources.join(' + ')}` : 'no labor in this view'}
          </p>
        </div>
      </div>
    </section>
  );
}
