'use client';

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppShell } from '@/components/layout/AppShell';
import { useDataStore } from '@/lib/data/store';
import { Payroll } from '@/types';
import {
  Plus,
  Search,
  Printer,
  ShieldCheck,
  Check,
  User,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { FilterSummary } from '@/components/ui/FilterSummary';
import { WorkspaceHeader } from '@/components/ui/WorkspaceHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { WorkspaceFilters } from '@/components/ui/WorkspaceFilters';
import { useToast } from '@/components/ui/Toast';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SearchableSelect } from '@/components/ui/SearchableSelect';
import { Modal } from '@/components/ui/Modal';
import { formatPeso, formatPesoCompact } from '@/lib/email/format';
import { formatRecordedWork } from '@/lib/payroll/display';
import { AttendanceMatrix } from '@/components/payroll/AttendanceMatrix';
import { getManilaClock } from '@/lib/reminders/scheduler';

export default function PayrollPage() {
  const { showToast } = useToast();
  const [pendingPayAction, setPendingPayAction] = useState<{ pay: Payroll; status: 'approved' | 'paid' } | null>(null);
  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);
  const statusLock = React.useRef(false);
  const generateLock = React.useRef(false);
  const {
    payroll,
    workers,
    projects,
    attendance,
    advances,
    createPayrollRun,
    updatePayrollStatus,
  } = useDataStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');

  // Modals
  const [isGenerateModalOpen, setIsGenerateModalOpen] = useState(false);
  const [isPayslipModalOpen, setIsPayslipModalOpen] = useState(false);
  const [isPrintAllModalOpen, setIsPrintAllModalOpen] = useState(false);
  const [printDateRange, setPrintDateRange] = useState<{ start: string; end: string }>({ start: '', end: '' });
  const [printSiteId, setPrintSiteId] = useState<string>('all');
  const [printVouchers, setPrintVouchers] = useState<Payroll[]>([]);
  const [selectedPayroll, setSelectedPayroll] = useState<Payroll | null>(null);

  // Generate run state (defaults to the past 7 days through today)
  const todayStr = getManilaClock().dateIso;
  const weekAgoStr = new Date(Date.parse(`${todayStr}T00:00:00Z`) - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [periodStart, setPeriodStart] = useState(weekAgoStr);
  const [periodEnd, setPeriodEnd] = useState(todayStr);
  const [generateProjectId, setGenerateProjectId] = useState<string>('all');
  const [isGenerating, setIsGenerating] = useState(false);

  const formatPHP = formatPesoCompact;

  /** Chunks an array into groups of `size` (used for 3×3 = 9 slips per A4 page). */
  const chunkBy = <T,>(arr: T[], size: number): T[][] =>
    arr.reduce<T[][]>((acc, _, i) => (i % size === 0 ? [...acc, arr.slice(i, i + size)] : acc), []);

  /**
   * Resolves the project site(s) associated with a payroll record using:
   * 1. Attendance logged by the worker during the payroll period
   * 2. Project site names recorded in `pay.notes`
   * 3. Fallback to the worker's overall attendance/advance project assignments
   */
  const getProjectsForPayroll = (pay: Payroll) => {
    const periodProjectIds = new Set(
      attendance
        .filter(
          (a) =>
            a.worker_id === pay.worker_id &&
            a.date >= pay.period_start &&
            a.date <= pay.period_end
        )
        .map((a) => a.project_id)
    );

    if (pay.notes) {
      projects.forEach((proj) => {
        if (pay.notes?.toLowerCase().includes(proj.name.toLowerCase())) {
          periodProjectIds.add(proj.id);
        }
      });
    }

    if (periodProjectIds.size === 0) {
      attendance
        .filter((a) => a.worker_id === pay.worker_id)
        .forEach((a) => periodProjectIds.add(a.project_id));
      advances
        .filter((adv) => adv.worker_id === pay.worker_id)
        .forEach((adv) => periodProjectIds.add(adv.project_id));
    }

    return projects.filter((p) => periodProjectIds.has(p.id));
  };

  /**
   * A slip belongs to the print range when its whole period sits inside the
   * chosen dates and, if a site is selected, the worker was allocated to that
   * site during the period. Site resolution matches the list view exactly:
   * attendance in the period → project names in `notes` → the worker's overall
   * attendance/advance assignments.
   */
  const matchesPrintRange = (pay: Payroll) => {
    if (!printDateRange.start || !printDateRange.end) return false;
    if (pay.period_start < printDateRange.start || pay.period_end > printDateRange.end) return false;
    if (printSiteId === 'all') return true;
    return getProjectsForPayroll(pay).some((project) => project.id === printSiteId);
  };

  // Only evaluated while the dialog is open, so the page render stays cheap.
  const printRangeVouchers = isPrintAllModalOpen ? payroll.filter(matchesPrintRange) : [];
  const printPageCount = Math.ceil(printRangeVouchers.length / 9);
  const printSiteName =
    printSiteId === 'all' ? null : projects.find((project) => project.id === printSiteId)?.name ?? null;

  /**
   * Freezes the selected slips into `printVouchers` and prints them.
   *
   * The A4 document is rendered through a portal straight into <body> (see the
   * JSX below), so closing this modal no longer removes the print template and
   * the modal chrome never reaches the printer.
   */
  const handlePrintAllSlips = () => {
    if (!printDateRange.start || !printDateRange.end) {
      showToast('error', 'Please select both start and end dates.');
      return;
    }
    if (printDateRange.start > printDateRange.end) {
      showToast('error', 'The start date must be on or before the end date.');
      return;
    }

    const vouchers = payroll.filter(matchesPrintRange);
    if (vouchers.length === 0) {
      showToast('error', 'No payroll slips found for that date range and site.');
      return;
    }

    setPrintVouchers(vouchers);
    setIsPrintAllModalOpen(false);
    // Wait one paint so the portal document is in the DOM before printing.
    window.setTimeout(() => window.print(), 150);
  };

  // Drop the frozen snapshot once the browser is done printing, so the
  // print-isolation CSS never affects a later single-payslip print.
  useEffect(() => {
    if (printVouchers.length === 0) return;
    const clearPrintSnapshot = () => setPrintVouchers([]);
    window.addEventListener('afterprint', clearPrintSnapshot);
    return () => window.removeEventListener('afterprint', clearPrintSnapshot);
  }, [printVouchers]);

  const filteredPayroll = payroll.filter((p) => {
    const worker = workers.find((w) => w.id === p.worker_id);
    const payProjects = getProjectsForPayroll(p);

    const matchesProject =
      projectFilter === 'all' || payProjects.some((proj) => proj.id === projectFilter);

    const matchesSearch =
      worker?.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      worker?.position.toLowerCase().includes(searchQuery.toLowerCase()) ||
      payProjects.some((proj) => proj.name.toLowerCase().includes(searchQuery.toLowerCase())) ||
      (p.notes && p.notes.toLowerCase().includes(searchQuery.toLowerCase()));

    const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
    return matchesProject && matchesSearch && matchesStatus;
  });

  const totalNetDisbursement = filteredPayroll.reduce((sum, p) => sum + Number(p.net_pay || 0), 0);
  const totalBaleRecovered = filteredPayroll.reduce((sum, p) => sum + Number(p.bale_deduction || 0), 0);

  const periodAttendanceRecords = attendance.filter(
    (a) =>
      a.date >= periodStart &&
      a.date <= periodEnd &&
      (generateProjectId === 'all' || a.project_id === generateProjectId)
  );
  const periodAttendanceCount = periodAttendanceRecords.length;
  const unverifiedSelfLogsCount = periodAttendanceRecords.filter(
    (a) =>
      a.worker_id === a.recorded_by &&
      !a.is_founder_override &&
      (a.status === 'present' || a.status === 'half_day')
  ).length;

  const existingPeriodVouchers = payroll.filter(
    (p) => p.period_start === periodStart && p.period_end === periodEnd
  );

  const handleGenerateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (generateLock.current) return;
    generateLock.current = true;
    setIsGenerating(true);
    try {
      const created = await createPayrollRun(periodStart, periodEnd, generateProjectId);
      if (created) {
        setIsGenerateModalOpen(false);
      }
    } catch {
      showToast('error', 'Could not confirm the payroll run. Refresh and check the vouchers before trying again.');
    } finally {
      generateLock.current = false;
      setIsGenerating(false);
    }
  };

  const handleConfirmStatus = async () => {
    if (!pendingPayAction || statusLock.current) return;
    statusLock.current = true;
    setIsUpdatingStatus(true);
    try {
      const success = await updatePayrollStatus(pendingPayAction.pay.id, pendingPayAction.status);
      if (success) {
        showToast('success', pendingPayAction.status === 'paid'
          ? 'Payroll payment and Bale deductions recorded.'
          : 'Payroll voucher approved.');
        setPendingPayAction(null);
      } else {
        showToast('error', 'Update not confirmed. Check payroll and the advance ledger before retrying.');
      }
    } catch {
      showToast('error', 'Update not confirmed. Check payroll and the advance ledger before retrying.');
    } finally {
      statusLock.current = false;
      setIsUpdatingStatus(false);
    }
  };

  return (
    <AppShell requireFounder={true}>
      <div className="space-y-6">
        <WorkspaceHeader
          eyebrow="Workforce & pay"
          title="Payroll"
          description="Review attendance-based vouchers, Bale deductions and worker payslips."
          action={
            <div className="flex gap-2">
              <Button variant="primary" size="md" onClick={() => setIsGenerateModalOpen(true)} leftIcon={<Plus className="w-4 h-4" />}>
                New Payroll Run
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={() => setIsPrintAllModalOpen(true)}
                leftIcon={<Printer className="w-4 h-4" />}
              >
                Print All Payroll Slips
              </Button>
            </div>
          }
        />

        <AttendanceMatrix start={periodStart} end={periodEnd} site={generateProjectId} setStart={setPeriodStart} setEnd={setPeriodEnd} setSite={setGenerateProjectId} projects={projects} />

        {/* Top Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 auto-rows-fr">
          <div className="h-full p-4 sm:p-5 rounded-xl bg-white border border-surface-border flex flex-col justify-between">
            <div className="text-xs font-medium text-ink-secondary">Net pay on shown vouchers</div>
            <div className="text-2xl font-bold text-navy mt-1 tabular-nums break-words">{formatPHP(totalNetDisbursement)}</div>
          </div>

          <div className="h-full p-4 sm:p-5 rounded-xl bg-white border border-surface-border flex flex-col justify-between">
            <div className="text-xs font-medium text-ink-secondary">Bale deductions on shown vouchers</div>
            <div className="text-2xl font-bold text-status-success mt-1 tabular-nums break-words">{formatPHP(totalBaleRecovered)}</div>
          </div>

          <div className="h-full p-4 sm:p-5 rounded-xl bg-white border border-surface-border flex flex-col justify-between">
            <div className="text-xs font-medium text-ink-secondary">Vouchers needing review</div>
            <div className="text-2xl font-bold text-status-warning mt-1 tabular-nums">
              {filteredPayroll.filter((p) => p.status === 'draft' || p.status === 'reviewed').length}
            </div>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-ink-secondary">Summary reflects the current filters and includes vouchers of all shown statuses. Deductions on draft or approved vouchers are not necessarily collected.</p>

        <WorkspaceFilters
          title="Find a payroll voucher"
          summary={<FilterSummary count={filteredPayroll.length} itemName="payroll" active={Boolean(searchQuery) || projectFilter !== 'all' || statusFilter !== 'all'} onClear={() => { setSearchQuery(''); setProjectFilter('all'); setStatusFilter('all'); }} />}
          search={
            <Input
              label="Search payroll"
              placeholder="Search worker, position, or project..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              leftIcon={<Search className="w-4 h-4" />}
            />
          }
          filters={
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <div className="w-full sm:w-64">
                <SearchableSelect
                  label="Project"
                  searchLabel="Search voucher project sites"
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  fixedOption={{ label: 'All Project Sites', value: 'all' }}
                  options={projects.map((p) => ({
                    label: `${p.name} (${p.location.split(',')[0]})`,
                    value: p.id,
                  }))}
                />
              </div>

              <div className="w-full sm:w-48">
                <Select
                  label="Status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  options={[
                    { label: 'All Statuses', value: 'all' },
                    { label: 'Draft', value: 'draft' },
                    { label: 'Reviewed', value: 'reviewed' },
                    { label: 'Approved', value: 'approved' },
                    { label: 'Paid', value: 'paid' },
                  ]}
                />
              </div>
            </div>
          }
          activeFilterCount={(projectFilter !== 'all' ? 1 : 0) + (statusFilter !== 'all' ? 1 : 0)}
          onClearFilters={() => { setProjectFilter('all'); setStatusFilter('all'); }}
          resultCount={filteredPayroll.length}
        />

        {/* Payroll Table */}
        <div data-page-guide="list" className="bg-white rounded-xl border border-surface-border overflow-hidden">
          <div className="divide-y divide-surface-border/70">
            {filteredPayroll.map((pay) => {
              const worker = workers.find((w) => w.id === pay.worker_id);
              const payProjects = getProjectsForPayroll(pay);

              const statusBadgeVariant =
                pay.status === 'paid'
                  ? 'success'
                  : pay.status === 'approved'
                  ? 'info'
                  : 'warning';

              return (
                <div
                  key={pay.id}
                  className="p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 hover:bg-surface transition-colors"
                >
                  {/* Left: Worker info */}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center flex-wrap gap-2">
                      <span className="font-bold text-sm text-navy">{worker?.name}</span>
                      <span className="text-xs text-ink-secondary">({worker?.position})</span>
                      <Badge variant={statusBadgeVariant} size="sm">
                        {pay.status}
                      </Badge>
                    </div>

                    <div className="text-xs text-ink-secondary">
                      Period: <span className="font-semibold text-navy">{pay.period_start} → {pay.period_end}</span> · Days: {formatRecordedWork(pay.days_worked, 'days')} · Hours: {formatRecordedWork(pay.hours_worked, 'hours')}
                    </div>

                    {payProjects.length > 0 && (
                      <div className="text-xs text-ink-secondary flex items-center flex-wrap gap-1.5">
                        <span>Project Site{payProjects.length > 1 ? 's' : ''}:</span>
                        {payProjects.map((proj) => (
                          <span
                            key={proj.id}
                            className="min-w-0 max-w-full truncate px-2 py-0.5 rounded-lg bg-surface-inset border border-surface-border text-[11px] font-semibold text-navy"
                          >
                            {proj.name}
                          </span>
                        ))}
                      </div>
                    )}

                    {pay.notes && (
                      <div className="break-words text-xs text-ink-muted italic">{pay.notes}</div>
                    )}
                  </div>

                  {/* Middle: Calculation columns */}
                  <div className="grid grid-cols-3 gap-4 text-xs py-2 lg:py-0">
                    <div>
                      <div className="text-ink-secondary">Gross Wages</div>
                      <div className="font-bold text-navy text-sm mt-0.5">{formatPeso(pay.gross_pay)}</div>
                    </div>

                    <div>
                      <div className="text-ink-secondary">Bale Deduction</div>
                      <div className={`font-bold text-sm mt-0.5 ${pay.bale_deduction > 0 ? 'text-status-danger' : 'text-slate-400'}`}>
                        -{formatPeso(pay.bale_deduction)}
                      </div>
                    </div>

                    <div>
                      <div className="text-ink-secondary font-semibold">Net Pay</div>
                      <div className="font-extrabold text-navy text-base mt-0.5">{formatPeso(pay.net_pay)}</div>
                    </div>
                  </div>

                  {/* Right: Actions */}
                  <div className="flex items-center flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setSelectedPayroll(pay);
                        setIsPayslipModalOpen(true);
                      }}
                      leftIcon={<Printer className="w-3.5 h-3.5" />}
                    >
                      Print Payslip
                    </Button>

                    {(pay.status === 'draft' || pay.status === 'reviewed') && (
                      <Button
                        variant="soft"
                        size="sm"
                        onClick={() => setPendingPayAction({ pay, status: 'approved' })}
                        leftIcon={<ShieldCheck className="w-3.5 h-3.5 text-navy" />}
                      >
                        Approve
                      </Button>
                    )}

                    {pay.status === 'approved' && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setPendingPayAction({ pay, status: 'paid' })}
                        leftIcon={<Check className="w-3.5 h-3.5" />}
                      >
                        Mark as Paid
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}

            {filteredPayroll.length === 0 && (
              <EmptyState title={payroll.length === 0 ? 'No payroll vouchers yet' : 'No payroll vouchers match'} description={payroll.length === 0 ? 'No payroll vouchers have been recorded yet.' : 'No payroll vouchers match the current search or filters. Clear filters to see all vouchers.'} />
            )}
          </div>
        </div>
      </div>

      {/* GENERATE RUN MODAL */}
      <Modal
        isOpen={isGenerateModalOpen}
        onClose={() => setIsGenerateModalOpen(false)}
        dismissOnBackdrop={!isGenerating}
        dismissOnEscape={!isGenerating}
        showCloseButton={!isGenerating}
        title="Compute Weekly / Bi-Monthly Payroll"
        description="Calculate gross pay from attendance and suggest Bale deductions. Deductions are attempted when the voucher is marked paid."
      >
        <form onSubmit={handleGenerateSubmit} className="space-y-4 text-xs">
          <SearchableSelect
            label="Project Site Scope"
            searchLabel="Search payroll run sites"
            value={generateProjectId}
            onChange={(e) => setGenerateProjectId(e.target.value)}
            fixedOption={{ label: 'All Project Sites (Firm-wide Run)', value: 'all' }}
            options={projects.map((p) => ({
              label: `${p.name} (${p.location.split(',')[0]})`,
              value: p.id,
            }))}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Period Start Date"
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              max={periodEnd}
              required
            />
            <Input
              label="Period End Date"
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              min={periodStart}
              required
            />
          </div>

          <div className="p-3.5 rounded-2xl bg-surface-inset border border-surface-border space-y-1.5 text-ink-secondary">
            <div className="flex items-center justify-between">
              <span className="font-bold text-navy text-xs">Attendance currently loaded:</span>
              <Badge variant={periodAttendanceCount > 0 ? 'success' : 'warning'} size="sm">
                {periodAttendanceCount} loaded log{periodAttendanceCount === 1 ? '' : 's'} in range
              </Badge>
            </div>
            <div>
              This preview may omit records. Generating checks the selected period directly from the server. Review the resulting vouchers before approval, and avoid concurrent payroll, attendance or advance changes during generation.
            </div>
            {unverifiedSelfLogsCount > 0 && (
              <div className="text-[11px] font-semibold text-status-warning pt-1 border-t border-surface-border/60">
                At least {unverifiedSelfLogsCount} supervisor self-attendance log(s) need Founder verification on the Attendance page. Other unverified supervisor records may also be held back.
              </div>
            )}
            <div className="text-[11px] font-semibold text-navy pt-1 border-t border-surface-border/60">
              {existingPeriodVouchers.length > 0 && <>At least {existingPeriodVouchers.length} loaded voucher(s) exist for {periodStart} → {periodEnd}. </>}
              The run recalculates eligible draft or reviewed vouchers; approved and paid vouchers are skipped. A site-scoped run may recalculate an existing worker-period voucher rather than creating a separate voucher for that site.
            </div>
          </div>

          <div className="pt-3 flex justify-end space-x-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setIsGenerateModalOpen(false)}
              disabled={isGenerating}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              isLoading={isGenerating}
              disabled={isGenerating}
            >
              {isGenerating ? 'Preparing payroll…' : 'Generate / Refresh Payroll Run'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(pendingPayAction)}
        onClose={() => setPendingPayAction(null)}
        dismissOnBackdrop={!isUpdatingStatus}
        dismissOnEscape={!isUpdatingStatus}
        showCloseButton={!isUpdatingStatus}
        title={pendingPayAction?.status === 'paid' ? 'Confirm payroll payment' : 'Approve payroll voucher'}
        description={pendingPayAction?.status === 'paid' ? 'Only mark this voucher paid after the worker has actually been paid.' : 'Review the voucher before approving it.'}
      >
        {pendingPayAction && (
          <div className="space-y-4 text-xs">
            <div className="space-y-1 rounded-xl border border-surface-border bg-surface-inset p-4">
              <p className="text-sm font-semibold text-navy">{workers.find((worker) => worker.id === pendingPayAction.pay.worker_id)?.name || 'Worker unavailable'}</p>
              <p className="text-ink-secondary">Period: {pendingPayAction.pay.period_start} → {pendingPayAction.pay.period_end}</p>
              <p className="font-semibold text-navy">Net pay: {formatPeso(pendingPayAction.pay.net_pay)}</p>
              <p className="text-ink-secondary">Bale deduction on voucher: {formatPeso(pendingPayAction.pay.bale_deduction)}</p>
            </div>
            {pendingPayAction.status === 'paid' && pendingPayAction.pay.bale_deduction > 0 && (
              <p className="rounded-xl border border-status-warning/25 bg-status-warning-bg px-3 py-2.5 leading-relaxed text-ink-secondary">
                Payment status and Bale deductions are recorded together. If the current active Bale balance is insufficient, the payment cannot be recorded. If the result is unconfirmed, refresh and check both ledgers before retrying; historical payments may still need reconciliation.
              </p>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" disabled={isUpdatingStatus} onClick={() => setPendingPayAction(null)}>Cancel</Button>
              <Button type="button" variant="primary" isLoading={isUpdatingStatus} onClick={handleConfirmStatus}>
                {isUpdatingStatus ? 'Updating…' : pendingPayAction.status === 'paid' ? 'Confirm paid' : 'Approve voucher'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* PRINTABLE PAYSLIP MODAL */}
      <Modal
        isOpen={isPayslipModalOpen}
        onClose={() => setIsPayslipModalOpen(false)}
        title="Asinta Architects — Official Worker Payslip"
        description="Printable worker compensation slip and signed acknowledgment."
        maxWidth="lg"
      >
        {selectedPayroll && (() => {
          const worker = workers.find((w) => w.id === selectedPayroll.worker_id);

          return (
            <div className="space-y-6">
              {/* Printable Payslip Card */}
              <div data-print-document="payslip" className="p-6 rounded-2xl bg-white border border-slate-300 font-sans space-y-5 text-ink-primary">
                {/* Header */}
                <div className="flex items-start justify-between pb-4 border-b-2 border-navy">
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="text-xs font-bold text-navy tracking-tight">ASINTA ARCHITECTS</div>
                      <div className="text-[10px] font-medium text-ink-secondary mt-0.5">
                        Design · Build · Batangas
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-bold text-navy">WORKER PAYSLIP · {selectedPayroll.status.toUpperCase()}</div>
                    <div className="text-[11px] text-ink-secondary tabular-nums">
                      Period: {selectedPayroll.period_start} to {selectedPayroll.period_end}
                    </div>
                  </div>
                </div>

                {/* Worker Details */}
                <div className="grid grid-cols-2 gap-4 text-xs">
                  <div>
                    <div className="text-[10px] font-bold uppercase text-ink-secondary">Worker Name</div>
                    <div className="font-bold text-navy text-sm mt-0.5">{worker?.name}</div>
                    <div className="text-ink-secondary">{worker?.position}</div>
                    {getProjectsForPayroll(selectedPayroll).length > 0 && (
                      <div className="text-[11px] text-navy font-semibold mt-1">
                        Site: {getProjectsForPayroll(selectedPayroll).map((p) => p.name).join(', ')}
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-ink-secondary">Days worked: {formatRecordedWork(selectedPayroll.days_worked, 'days')}</div>
                  </div>
                </div>

                {/* Breakdown Table */}
                <div className="border border-slate-200 rounded-xl overflow-x-auto text-xs">
                  <table className="w-full">
                    <thead className="bg-slate-50 font-bold text-navy uppercase text-[10px] border-b border-slate-200">
                      <tr>
                        <th className="p-2.5 text-left">Earnings & Deductions</th>
                        <th className="p-2.5 text-right">Amount (PHP)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      <tr>
                        <td className="p-2.5">Gross wages</td>
                        <td className="p-2.5 text-right font-mono font-bold text-navy">{formatPeso(selectedPayroll.gross_pay)}</td>
                      </tr>
                      {selectedPayroll.bale_deduction > 0 && (
                        <tr className="text-status-danger">
                          <td className="p-2.5">Bale / Cash Advance Deduction</td>
                          <td className="p-2.5 text-right font-mono font-bold">-{formatPeso(selectedPayroll.bale_deduction)}</td>
                        </tr>
                      )}
                      {selectedPayroll.other_deductions > 0 && (
                        <tr className="text-status-danger">
                          <td className="p-2.5">Other Deductions / Tools</td>
                          <td className="p-2.5 text-right font-mono font-bold">-{formatPeso(selectedPayroll.other_deductions)}</td>
                        </tr>
                      )}
                      <tr className="bg-slate-50/80 font-black text-sm text-navy">
                        <td className="p-2.5">NET TAKE-HOME PAY</td>
                        <td className="p-2.5 text-right font-mono text-base">{formatPeso(selectedPayroll.net_pay)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Architect Signature — matches the batch slips: the architect
                    signs the payslip, workers do not. */}
                <div className="pt-4 border-t border-slate-200 flex justify-end text-[11px]">
                  <div className="w-56 text-center">
                    <div className="border-b border-navy" />
                    <div className="mt-1 text-[10px] font-bold text-navy">Ar. Junel Buyagon</div>
                    <div className="text-[9px] text-ink-muted">Principal Architect</div>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-between items-center">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => window.print()}
                  leftIcon={<Printer className="w-3.5 h-3.5" />}
                >
                  Print Payslip
                </Button>
                <Button variant="primary" size="sm" onClick={() => setIsPayslipModalOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* PRINT ALL PAYROLL SLIPS — date range picker only (never printed) */}
      <Modal
        isOpen={isPrintAllModalOpen}
        onClose={() => setIsPrintAllModalOpen(false)}
        title="Print All Payroll Slips"
        description="Pick the payroll period, then print 9 slips per A4 page."
        maxWidth="lg"
      >
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Select
                label="Project site"
                value={printSiteId}
                onChange={(e) => setPrintSiteId(e.target.value)}
                options={[
                  { label: 'All sites', value: 'all' },
                  ...projects
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((project) => ({ label: project.name, value: project.id })),
                ]}
                hint="A slip is included when the worker was allocated to this site during the period."
              />
            </div>
            <Input
              label="Date from"
              type="date"
              value={printDateRange.start}
              onChange={(e) => setPrintDateRange((range) => ({ ...range, start: e.target.value }))}
            />
            <Input
              label="Date to"
              type="date"
              value={printDateRange.end}
              onChange={(e) => setPrintDateRange((range) => ({ ...range, end: e.target.value }))}
            />
          </div>

          <p className="text-xs text-ink-secondary" aria-live="polite">
            {printRangeVouchers.length === 0
              ? 'No payroll slips fall inside this date range and site.'
              : `${printRangeVouchers.length} payroll slip${printRangeVouchers.length === 1 ? '' : 's'} ${printSiteName ? `for ${printSiteName} ` : ''}will be printed on ${printPageCount} A4 page${printPageCount === 1 ? '' : 's'} (3x3 grid per page).`}
          </p>

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" size="md" onClick={() => setIsPrintAllModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={handlePrintAllSlips}
              leftIcon={<Printer className="w-4 h-4" />}
              disabled={printRangeVouchers.length === 0}
            >
              Print to PDF
            </Button>
          </div>
        </div>
      </Modal>

      {/*
        PRINT-ONLY DOCUMENT
        Portalled into <body> so it lives outside the Modal, the AppShell and the
        page layout. `window.print()` therefore never sees the date picker, the
        count text, the modal header/buttons or any app chrome: the print
        stylesheet below hides every other direct child of <body>.
      */}
      {typeof document !== 'undefined' && printVouchers.length > 0
        ? createPortal(
            <div id="payroll-slips-print-root" className="pp-doc">
              {chunkBy(printVouchers, 9).map((page, pageIndex) => (
                <section key={pageIndex} className="pp-page" aria-label={`Payroll slips page ${pageIndex + 1}`}>
                  <div className="pp-grid">
                    {page.map((pay) => {
                      const worker = workers.find((w) => w.id === pay.worker_id);
                      return (
                        <article key={pay.id} className="pp-slip">
                          <div className="pp-slip-head">
                            <span className="pp-icon" aria-hidden="true">
                              <User />
                            </span>
                            <span className="pp-name">{worker?.name || 'Worker'}</span>
                          </div>
                          <div className="pp-period">
                            {pay.period_start} <span className="pp-arrow">→</span> {pay.period_end}
                          </div>
                          <div className="pp-site">
                            <span className="pp-site-label">Site:</span>{' '}
                            {(() => {
                              const siteNames = getProjectsForPayroll(pay).map((project) => project.name);
                              return siteNames.length > 0 ? siteNames.join(', ') : 'No site recorded';
                            })()}
                          </div>
                          <dl className="pp-rows">
                            <div className="pp-row">
                              <dt>Gross Pay</dt>
                              <dd>{formatPeso(pay.gross_pay)}</dd>
                            </div>
                            {pay.bale_deduction > 0 && (
                              <div className="pp-row pp-row--deduction">
                                <dt>Bale Deduction</dt>
                                <dd>-{formatPeso(pay.bale_deduction)}</dd>
                              </div>
                            )}
                            <div className="pp-row pp-row--net">
                              <dt>Net Pay</dt>
                              <dd>{formatPeso(pay.net_pay)}</dd>
                            </div>
                          </dl>
                          {/* Signed by the architect only — workers do not sign these slips. */}
                          <div className="pp-sign">
                            <span className="pp-sign-line" aria-hidden="true" />
                            <span className="pp-sign-name">Ar. Junel Buyagon</span>
                            <span className="pp-sign-title">Principal Architect</span>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>,
            document.body
          )
        : null}

      {/*
        Print CSS is scoped to `#payroll-slips-print-root`, so the single-payslip
        modal (which relies on the global `body:has([data-print-document])`
        rules in globals.css) keeps working exactly as before.
      */}
      <style>{`
        /* The A4 document only exists for printing. */
        .pp-doc { display: none; }

        @media print {
          /* Isolate the slip document: everything else in <body> is removed
             from the page, including the modal, its backdrop and the app shell. */
          body:has(#payroll-slips-print-root) > *:not(#payroll-slips-print-root) { display: none !important; }

          body:has(#payroll-slips-print-root) {
            margin: 0 !important;
            padding: 0 !important;
            background: #FFFFFF !important;
            color: #0B1F3A !important;
            overflow: visible !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }

          #payroll-slips-print-root {
            display: block !important;
            width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            background: #FFFFFF !important;
            color: #172033 !important;
            font-family: 'Inter Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }

          /* 180 x 266 mm fits inside A4 at either 8 mm or 12 mm margins, so the
             3x3 grid can never spill onto a second physical page. */
          #payroll-slips-print-root .pp-page {
            width: 180mm;
            margin: 0 auto;
            break-after: page;
            page-break-after: always;
          }
          #payroll-slips-print-root .pp-page:last-child {
            break-after: auto;
            page-break-after: auto;
          }

          #payroll-slips-print-root .pp-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            grid-auto-rows: 86mm;
            gap: 4mm;
          }

          #payroll-slips-print-root .pp-slip {
            display: flex;
            flex-direction: column;
            justify-content: center;
            box-sizing: border-box;
            height: 86mm;
            padding: 4mm;
            overflow: hidden;
            border: 0.35mm solid #C9D2DE;
            border-radius: 0;
            background: #FFFFFF;
            break-inside: avoid;
            page-break-inside: avoid;
          }

          #payroll-slips-print-root .pp-slip-head {
            display: flex;
            align-items: center;
            gap: 2mm;
            padding-bottom: 2mm;
            border-bottom: 0.35mm solid #E1E6ED;
          }
          #payroll-slips-print-root .pp-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 7mm;
            height: 7mm;
            flex: 0 0 7mm;
            border-radius: 999px;
            background: #F1F4F8;
            color: #1E4D78;
          }
          #payroll-slips-print-root .pp-icon svg { width: 4.5mm; height: 4.5mm; stroke-width: 2; }
          #payroll-slips-print-root .pp-name {
            font-size: 11pt;
            font-weight: 700;
            line-height: 1.15;
            color: #0B1F3A;
            overflow-wrap: anywhere;
          }

          #payroll-slips-print-root .pp-period {
            margin-top: 2mm;
            font-size: 8pt;
            line-height: 1.25;
            color: #4E5A6B;
            font-variant-numeric: tabular-nums;
          }
          #payroll-slips-print-root .pp-arrow { color: #A5A5A5; }

          /* Project site the worker was allocated to during the period. */
          #payroll-slips-print-root .pp-site {
            margin-top: 1.5mm;
            font-size: 7.5pt;
            line-height: 1.25;
            color: #4E5A6B;
            overflow-wrap: anywhere;
          }
          #payroll-slips-print-root .pp-site-label { font-weight: 700; color: #0B1F3A; }

          /* The content block is vertically centred inside the 86 mm cell, so
             every ticket in the grid lines up regardless of how many
             deduction rows it has. */
          #payroll-slips-print-root .pp-rows { margin: 4mm 0 0; }
          #payroll-slips-print-root .pp-row {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 2mm;
            padding: 1.2mm 0;
            font-size: 9pt;
            line-height: 1.2;
          }
          #payroll-slips-print-root .pp-row dt { color: #4E5A6B; }
          #payroll-slips-print-root .pp-row dd {
            margin: 0;
            font-weight: 700;
            font-variant-numeric: tabular-nums;
            color: #0B1F3A;
            white-space: nowrap;
          }
          #payroll-slips-print-root .pp-row--deduction dd { color: #C52828; }
          #payroll-slips-print-root .pp-row--net {
            margin-top: 1mm;
            padding-top: 2mm;
            border-top: 0.35mm solid #C9D2DE;
          }
          #payroll-slips-print-root .pp-row--net dt { font-weight: 700; color: #0B1F3A; }
          #payroll-slips-print-root .pp-row--net dd { font-size: 10.5pt; }

          /* Architect signature block: a rule to sign on, then the signatory. */
          #payroll-slips-print-root .pp-sign { margin-top: 5mm; }
          #payroll-slips-print-root .pp-sign-line {
            display: block;
            width: 32mm;
            border-top: 0.3mm solid #0B1F3A;
          }
          #payroll-slips-print-root .pp-sign-name {
            display: block;
            margin-top: 1.2mm;
            font-size: 7.5pt;
            font-weight: 700;
            line-height: 1.2;
            color: #0B1F3A;
          }
          #payroll-slips-print-root .pp-sign-title {
            display: block;
            font-size: 6.5pt;
            line-height: 1.2;
            color: #4E5A6B;
          }

          /* The single payslip prints with square corners too: the card and
             every rounded container inside it. */
          [data-print-document="payslip"], [data-print-document="payslip"] * { border-radius: 0 !important; }

          /* Anything marked .no-print or .print-hide never reaches paper. */
          .no-print, .print-hide { display: none !important; }
        }
      `}</style>

    </AppShell>
  );
}
