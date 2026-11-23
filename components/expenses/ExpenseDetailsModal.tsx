'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Expense, ExpenseCategory } from '@/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { ExpenseItemsEditor } from '@/components/expenses/ExpenseItemsEditor';
import { itemInputs, itemSubtotal, prepareExpenseItems, type ItemInput } from '@/lib/expenses/items';
import { formatPeso } from '@/lib/email/format';
import {
  advanceExpenseHref,
  expenseSourceOf,
  formatPeriodLabel,
  payrollExpenseHref,
  type PayrollRunBreakdown,
} from '@/lib/expenses/posting';

interface Props {
  expense: Expense | null;
  projects: { id: string; name: string }[];
  /** Vouchers behind a payroll row; empty/absent when the row is not from payroll. */
  payrollRun?: PayrollRunBreakdown | null;
  onClose: () => void;
  onUpdate: (id: string, patch: Partial<Expense>, expectedRevision?: number) => Promise<Expense | null>;
  onReceipt: (path: string) => void;
}

/** How many workers to list before collapsing into "… N more workers". */
const WORKERS_SHOWN = 5;

export function ExpenseDetailsModal({ expense, projects, payrollRun, onClose, onUpdate, onReceipt }: Props) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ description:'', details:'', amount:'', expense_date:'', project_id:'', category:'materials', vendor:'', notes:'' });
  const [rows, setRows] = useState<ItemInput[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const lock = React.useRef(false);

  const fillFromExpense = (target: Expense) => {
    setForm({ description:target.description, details:target.details || '', amount:String(target.amount), expense_date:target.expense_date, project_id:target.project_id, category:target.category, vendor:target.vendor || '', notes:target.notes || '' });
    setRows(itemInputs(target.line_items));
  };

  useEffect(() => {
    setEditing(false); setError('');
    if (expense) fillFromExpense(expense);
  }, [expense]);

  const startEditing = () => {
    if (!expense) return;
    fillFromExpense(expense);
    setError(''); setEditing(true);
  };

  const source = expense ? expenseSourceOf(expense) : 'manual';
  const linked = source !== 'manual';
  const period = expense ? formatPeriodLabel(expense.payroll_period_start, expense.payroll_period_end) : null;
  const printHref = expense ? payrollExpenseHref(expense, { print: true }) : null;
  const runHref = expense ? payrollExpenseHref(expense) : null;
  const run = source === 'payroll' ? payrollRun ?? null : null;

  const subtotal = expense ? itemSubtotal(expense.line_items || []) : null;
  const difference = expense && subtotal !== null ? (Math.round(expense.amount * 100) - Math.round(subtotal * 100)) / 100 : null;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!expense || lock.current) return;
    const parsed = prepareExpenseItems(rows);
    if (parsed.error) { setError(parsed.error); return; }
    if (!form.description.trim() || !form.project_id || !form.expense_date || !form.category || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(form.amount) || Number(form.amount) <= 0) {
      setError('Check the title, project, date, category and receipt total.'); return;
    }
    if (form.details.length > 5000) { setError('Keep details under 5,000 characters.'); return; }
    if (!Number.isSafeInteger(expense.revision)) { setError('Refresh the expense before editing; its current version is unavailable.'); return; }

    // Payroll and advances own the money fields. Send only what they do not own
    // so the posting rules can never be edited around from this screen.
    const patch: Partial<Expense> = linked
      ? {
          description: form.description.trim(),
          details: form.details.trim() || null,
          vendor: form.vendor.trim() || null,
          notes: form.notes.trim() || null,
        }
      : {
          description: form.description.trim(),
          details: form.details.trim() || null,
          amount: Number(form.amount),
          expense_date: form.expense_date,
          project_id: form.project_id,
          category: form.category as ExpenseCategory,
          vendor: form.vendor.trim() || null,
          notes: form.notes.trim() || null,
          line_items: parsed.items.length ? parsed.items : null,
        };

    lock.current = true; setSaving(true); setError('');
    try {
      const saved = await onUpdate(expense.id, patch, expense.revision);
      if (saved) { setEditing(false); onClose(); }
      else setError('The update was not confirmed. Refresh and check the expense before retrying.');
    } catch { setError('The update was not confirmed. Refresh and check the expense before retrying.'); }
    finally { lock.current = false; setSaving(false); }
  };

  const lockedInputHint = 'Managed by payroll or advances; change it at the source.';

  return <Modal isOpen={Boolean(expense)} onClose={onClose} dismissOnBackdrop={!saving} dismissOnEscape={!saving} showCloseButton={!saving} title={editing ? 'Edit expense' : 'Expense details'} maxWidth="5xl" presentation="workspace">
    {expense && (editing ? <form onSubmit={save} className="space-y-4" noValidate>
      <Input label="Expense title" value={form.description} onChange={e => setForm({...form,description:e.target.value})} required />
      <Textarea label="Description" maxLength={5000} rows={3} value={form.details} onChange={e => setForm({...form,details:e.target.value})} />
      <div className="grid gap-4 sm:grid-cols-2">
        {linked ? <>
          <Input label="Receipt total (₱)" value={formatPeso(expense.amount)} disabled hint={lockedInputHint} />
          <Input label="Expense date" type="date" value={form.expense_date} disabled hint={lockedInputHint} />
          <Select label="Project" value={form.project_id} disabled hint={lockedInputHint}><option value={form.project_id}>{projects.find(project => project.id === form.project_id)?.name || 'Project'}</option></Select>
          <Select label="Category" value={form.category} disabled hint={lockedInputHint}><option value={form.category}>{form.category}</option></Select>
        </> : <>
          <Input label="Receipt total (₱)" type="number" min="0.01" step="0.01" value={form.amount} onChange={e => setForm({...form,amount:e.target.value})} required />
          <Input label="Expense date" type="date" value={form.expense_date} onChange={e => setForm({...form,expense_date:e.target.value})} required />
          <Select label="Project" value={form.project_id} onChange={e => setForm({...form,project_id:e.target.value})}><option value="">Select a project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</Select>
          <Select label="Category" value={form.category} onChange={e => setForm({...form,category:e.target.value})}>{['materials','labor','equipment','permits','transportation','other'].map(category => <option key={category} value={category}>{category}</option>)}</Select>
        </>}
      </div>
      {linked ? (
        <p className="rounded-xl border border-surface-border bg-surface-inset/60 p-3 text-xs text-ink-secondary">
          The amount, date, site, category and the breakdown are managed by {source === 'payroll' ? 'payroll' : 'advances'}. Title, description, supplier and notes can be edited here.
        </p>
      ) : (
        <ExpenseItemsEditor rows={rows} onChange={setRows} receiptTotal={form.amount} />
      )}
      <p className="text-xs text-ink-secondary">Changes here do not change any separate Bale or advance record.</p>
      <Input label="Supplier" value={form.vendor} onChange={e => setForm({...form,vendor:e.target.value})} />
      <Textarea label="Notes / receipt number" rows={2} value={form.notes} onChange={e => setForm({...form,notes:e.target.value})} />
      {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="secondary" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button><Button type="submit" variant="primary" isLoading={saving}>Save changes</Button></div>
    </form> : <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="break-words font-bold text-navy">{expense.description}</p>
        <Badge variant="navy" size="sm" className="capitalize">{expense.category}</Badge>
        {source === 'payroll' && <Badge variant="info" size="sm">From payroll</Badge>}
        {source === 'advance' && <Badge variant="info" size="sm">From advance</Badge>}
        {linked && <Badge variant="neutral" size="sm">Locked</Badge>}
      </div>

      <dl className="grid grid-cols-2 gap-3 rounded-xl bg-surface-inset/50 p-4 text-sm">
        <div><dt className="text-ink-secondary">Receipt total</dt><dd className="mt-1 font-bold text-navy">{formatPeso(expense.amount)}</dd></div>
        <div><dt className="text-ink-secondary">Date</dt><dd className="mt-1 font-semibold text-navy">{expense.expense_date}</dd></div>
        <div><dt className="text-ink-secondary">Project</dt><dd className="mt-1 font-semibold text-navy">{projects.find(project => project.id === expense.project_id)?.name || 'Unavailable'}</dd></div>
        <div><dt className="text-ink-secondary">Category</dt><dd className="mt-1 font-semibold capitalize text-navy">{expense.category}</dd></div>
        {source === 'payroll' && period && <div><dt className="text-ink-secondary">Payroll period</dt><dd className="mt-1 font-semibold text-navy">{period}</dd></div>}
        {source === 'payroll' && run && run.totalVouchers > 0 && <div><dt className="text-ink-secondary">Vouchers paid</dt><dd className="mt-1 font-semibold text-navy">{run.paidVouchers} of {run.totalVouchers}</dd></div>}
        {expense.vendor && <div><dt className="text-ink-secondary">Supplier</dt><dd className="mt-1 break-words font-semibold text-navy">{expense.vendor}</dd></div>}
      </dl>

      {source === 'payroll' && run && run.rows.length > 0 && <>
        <div className="rounded-xl border border-surface-border bg-surface-inset/60 px-4 py-3 text-xs font-semibold text-navy">
          Gross {formatPeso(run.gross)} − Bale recovered {formatPeso(run.bale)} = <span className="text-status-success">Net released {formatPeso(run.net)}</span>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-bold text-navy">Workers paid</h3>
          <div className="overflow-x-auto rounded-xl border border-surface-border">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead className="bg-surface-inset text-ink-secondary">
                <tr>
                  <th className="p-3 font-semibold">Worker</th>
                  <th className="p-3 font-semibold">Days</th>
                  <th className="p-3 text-right font-semibold">Gross</th>
                  <th className="p-3 text-right font-semibold">Bale</th>
                  <th className="p-3 text-right font-semibold">Net</th>
                </tr>
              </thead>
              <tbody>
                {run.rows.slice(0, WORKERS_SHOWN).map(row => (
                  <tr key={row.id} className="border-t border-surface-border">
                    <td className="p-3 break-words">{row.workerName}</td>
                    <td className="p-3 tabular-nums">{row.days ?? '—'}</td>
                    <td className="p-3 text-right tabular-nums">{formatPeso(row.gross)}</td>
                    <td className={`p-3 text-right tabular-nums ${row.bale > 0 ? 'font-semibold text-status-danger' : 'text-ink-muted'}`}>
                      {row.bale > 0 ? `−${formatPeso(row.bale)}` : '—'}
                    </td>
                    <td className="p-3 text-right font-semibold tabular-nums">{formatPeso(row.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {run.rows.length > WORKERS_SHOWN && (
                  <tr className="border-t border-surface-border">
                    <td className="p-3 text-xs text-ink-secondary" colSpan={5}>… {run.rows.length - WORKERS_SHOWN} more worker{run.rows.length - WORKERS_SHOWN === 1 ? '' : 's'}</td>
                  </tr>
                )}
                <tr className="border-t border-surface-border bg-surface-inset/60 font-semibold">
                  <td className="p-3" colSpan={2}>Total (locked to payroll)</td>
                  <td className="p-3 text-right tabular-nums">{formatPeso(run.gross)}</td>
                  <td className={`p-3 text-right tabular-nums ${run.bale > 0 ? 'text-status-danger' : 'text-ink-muted'}`}>{run.bale > 0 ? `−${formatPeso(run.bale)}` : '—'}</td>
                  <td className="p-3 text-right tabular-nums">{formatPeso(run.net)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </>}

      {expense.details && <div><p className="text-xs font-semibold text-ink-secondary">Description</p><p className="mt-1 whitespace-pre-wrap break-words text-ink-primary">{expense.details}</p></div>}

      {linked && (
        <p className="rounded-xl border border-status-info/20 bg-status-info-bg/40 p-3 text-xs text-ink-secondary">
          Amount, project, date and category are managed by {source === 'payroll' ? 'payroll' : 'advances'}. Edit the title, details, supplier or notes here.
        </p>
      )}

      {!linked && expense.line_items?.length ? <div><h3 className="mb-2 text-xs font-bold text-navy">Receipt items</h3><div className="overflow-x-auto rounded-xl border border-surface-border"><table className="w-full min-w-[300px] text-left text-sm"><thead className="bg-surface-inset text-ink-secondary"><tr><th className="p-3">Item</th><th className="p-3">Quantity</th><th className="p-3 text-right">Amount</th></tr></thead><tbody>{expense.line_items.map((item,index) => <tr key={index} className="border-t border-surface-border"><td className="p-3 break-words">{item.name}</td><td className="p-3">{item.quantity || '—'}</td><td className="p-3 text-right tabular-nums">{item.amount == null ? '—' : formatPeso(item.amount)}</td></tr>)}</tbody></table></div>{subtotal !== null && <p className="mt-2 text-xs text-ink-secondary">Items subtotal: {formatPeso(subtotal)}{difference !== null && Math.abs(difference) >= 0.01 ? ` · Difference from receipt total: ${formatPeso(difference)} (e.g. tax, delivery or discounts)` : null}</p>}</div> : !linked ? <p className="text-xs text-ink-secondary">No item breakdown recorded.</p> : null}

      {expense.notes && <div><p className="text-xs font-semibold text-ink-secondary">Notes / receipt number</p><p className="mt-1 whitespace-pre-wrap break-words text-ink-primary">{expense.notes}</p></div>}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
        {expense.receipt_url && <Button type="button" variant="secondary" onClick={() => onReceipt(expense.receipt_url!)}>View receipt photo</Button>}
        {source === 'payroll' && printHref && <Link href={printHref}><Button type="button" variant="primary">Print payslips (3×3)</Button></Link>}
        {source === 'payroll' && runHref && <Link href={runHref}><Button type="button" variant="secondary">Open payroll run</Button></Link>}
        {source === 'advance' && <Link href={advanceExpenseHref()}><Button type="button" variant="secondary">Open advance</Button></Link>}
        <Button type="button" variant={linked ? 'secondary' : 'primary'} onClick={startEditing}>{linked ? 'Edit title or notes' : 'Edit expense'}</Button>
      </div>
    </div>)}
  </Modal>;
}
