'use client';

import React, { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from '@/lib/hooks/useMediaQuery';

interface WorkspaceFiltersProps {
  title: string;
  /** Always visible control — normally the search field. */
  search: React.ReactNode;
  /**
   * Everything that narrows the list beyond search (selects, dates). On phones
   * these live behind a single "Filters" button; from `sm` upwards they sit
   * inline next to the search field.
   */
  filters?: React.ReactNode;
  summary: React.ReactNode;
  /** Number of active non-search filters, shown as a badge on the mobile button. */
  activeFilterCount?: number;
  /** Clears every non-search filter; powers "Clear all" inside the mobile sheet. */
  onClearFilters?: () => void;
  /** Result count for the sheet's primary button ("Show 12 results"). */
  resultCount?: number;
}

/**
 * Keeps list controls and their result feedback in one clearly labelled region.
 *
 * Desktop: search + filters inline.
 * Phone: search stays visible, every other control moves into a bottom sheet so
 * the list starts higher on the screen instead of scrolling past four rows of
 * stacked inputs.
 */
export function WorkspaceFilters({
  title,
  search,
  filters,
  summary,
  activeFilterCount = 0,
  onClearFilters,
  resultCount,
}: WorkspaceFiltersProps) {
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const isCompact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const hasFilters = Boolean(filters);
  const filterLabel = `${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} applied`;

  return (
    <section
      data-page-guide="filters"
      aria-label={title}
      className="rounded-2xl border border-surface-border bg-white p-4 shadow-sm"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-navy">{title}</h2>
        <span className="hidden text-xs text-ink-secondary sm:inline">Search or narrow the list</span>
      </div>

      <div className="flex items-end gap-2 sm:flex-wrap sm:gap-3">
        <div className={hasFilters ? 'min-w-0 flex-1 sm:max-w-xs lg:max-w-sm' : 'min-w-0 w-full sm:max-w-md'}>
          {search}
        </div>

        {/* Desktop: filters inline. Not rendered on a phone, so the controls
            exist in exactly one place at a time (no duplicate inputs). */}
        {hasFilters && !isCompact && (
          <div className="hidden min-w-0 sm:flex sm:flex-1 sm:flex-wrap sm:items-end sm:gap-3">{filters}</div>
        )}

        {hasFilters && (
          <button
            type="button"
            onClick={() => setIsSheetOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={isSheetOpen}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-surface-border bg-white px-3 text-xs font-semibold text-navy transition-colors hover:border-brand/40 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 sm:hidden"
          >
            <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
            Filters
            {activeFilterCount > 0 && (
              <span
                aria-hidden="true"
                className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-[10px] font-bold text-white"
              >
                {activeFilterCount}
              </span>
            )}
            {activeFilterCount > 0 && <span className="sr-only">, {filterLabel}</span>}
          </button>
        )}
      </div>

      <div className="mt-2 border-t border-surface-border/70 pt-1">{summary}</div>

      {hasFilters && (
        <Modal
          isOpen={isSheetOpen}
          onClose={() => setIsSheetOpen(false)}
          title={`${title} · Filters`}
          description={activeFilterCount > 0 ? filterLabel : 'Narrow the list'}
          presentation="bottom-sheet"
          maxWidth="md"
        >
          <div className="space-y-4">
            <div className="space-y-3">{filters}</div>
            <div className="flex items-center justify-between gap-2 border-t border-surface-border/70 pt-3">
              {activeFilterCount > 0 && onClearFilters ? (
                <Button variant="ghost" size="sm" onClick={onClearFilters}>
                  Clear all
                </Button>
              ) : (
                <span />
              )}
              <Button variant="primary" size="sm" onClick={() => setIsSheetOpen(false)}>
                {typeof resultCount === 'number'
                  ? `Show ${resultCount} result${resultCount === 1 ? '' : 's'}`
                  : 'Done'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
