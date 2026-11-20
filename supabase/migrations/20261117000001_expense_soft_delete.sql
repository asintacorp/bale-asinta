-- Soft delete support for expenses
-- Adds removed_at column so expenses can be marked as removed instead of hard-deleted
-- Preserves financial audit trail while hiding removed expenses from the ledger

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS removed_at timestamptz;

-- Index for faster filtering of active (non-removed) expenses
CREATE INDEX IF NOT EXISTS idx_expenses_removed_at ON public.expenses(removed_at);

-- Comment for documentation
COMMENT ON COLUMN public.expenses.removed_at IS 'Timestamp when the expense was soft-deleted. NULL means active.';
