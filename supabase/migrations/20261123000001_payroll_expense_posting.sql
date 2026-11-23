-- Project-cost posting for payroll and Bale advances (labor → expenses).
--
-- Until now labor never reached the expense ledger: project profit is computed
-- from `expenses` only, so every peso paid to workers was invisible and every
-- project margin was overstated.
--
-- Cash model (agreed with the Founder):
--   * A released advance is a labor expense on the day it is issued — that is
--     when the cash physically left (advances.project_id gives the site).
--   * A paid payroll voucher records the NET released as labor. The Bale
--     deduction is recovery of an advance that was already expensed, so it is
--     never a second cost. Gross stays on the voucher and is shown as the
--     tie-out: Gross − Bale recovered = Net released.
--   * Therefore labor in the ledger = advances released + net payroll paid,
--     which over time equals the sum of gross wages.
--
-- Posting is idempotent: one expense per advance, one per (project, period).
-- Re-posting after more vouchers of the same run were paid updates the single
-- row instead of adding another.

-- ---------------------------------------------------------------------------
-- 1. Payroll now remembers the site it was generated for
-- ---------------------------------------------------------------------------

alter table public.payroll
  add column if not exists project_id uuid references public.projects(id) on delete restrict;

create index if not exists idx_payroll_project_period
  on public.payroll (project_id, period_start, period_end);

comment on column public.payroll.project_id is
  'Site the run was generated for. NULL for firm-wide runs; those cannot post a project cost automatically.';

-- ---------------------------------------------------------------------------
-- 2. Expenses learn where a row came from
-- ---------------------------------------------------------------------------

alter table public.expenses
  add column if not exists source text not null default 'manual',
  add column if not exists advance_id uuid references public.advances(id) on delete restrict,
  add column if not exists payroll_period_start date,
  add column if not exists payroll_period_end date;

alter table public.expenses drop constraint if exists expense_source_allowed;
alter table public.expenses add constraint expense_source_allowed
  check (source in ('manual', 'payroll', 'advance'));

alter table public.expenses drop constraint if exists expense_source_reference;
alter table public.expenses add constraint expense_source_reference check (
  (source = 'manual' and advance_id is null and payroll_period_start is null and payroll_period_end is null)
  or (source = 'advance' and advance_id is not null and payroll_period_start is null and payroll_period_end is null)
  or (source = 'payroll' and advance_id is null and payroll_period_start is not null and payroll_period_end is not null)
);

-- One row per advance and one per payroll run; these are what make re-posting
-- safe and what stop two browser tabs from creating two costs.
create unique index if not exists expenses_one_per_advance
  on public.expenses (advance_id) where source = 'advance';
create unique index if not exists expenses_one_per_payroll_run
  on public.expenses (project_id, payroll_period_start, payroll_period_end) where source = 'payroll';

comment on column public.expenses.source is
  'manual = typed in by the Founder; advance = posted from a released Bale advance; payroll = posted from paid payroll vouchers.';

-- ---------------------------------------------------------------------------
-- 3. Generated rows keep the fields their source owns
-- ---------------------------------------------------------------------------

create or replace function public.guard_linked_expense_fields()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    return new;
  end if;
  if old.source = 'manual' then
    return new;
  end if;
  -- The posting functions keep the row in sync on purpose.
  if coalesce(current_setting('app.payroll_posting', true), 'off') = 'on' then
    return new;
  end if;

  if (new.source, new.advance_id, new.project_id, new.category, new.amount,
      new.expense_date, new.payroll_period_start, new.payroll_period_end,
      new.removed_at)
     is distinct from
     (old.source, old.advance_id, old.project_id, old.category, old.amount,
      old.expense_date, old.payroll_period_start, old.payroll_period_end,
      old.removed_at)
  then
    raise exception
      'This expense was generated from % and its amounts are managed there. Change the source record instead.',
      old.source
      using errcode = '22023';
  end if;

  return new;
end $$;

drop trigger if exists guard_linked_expense_fields on public.expenses;
create trigger guard_linked_expense_fields before update on public.expenses
for each row execute function public.guard_linked_expense_fields();

-- ---------------------------------------------------------------------------
-- 4. Post one released advance
-- ---------------------------------------------------------------------------

create or replace function public.post_advance_expense(p_advance_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_advance public.advances%rowtype;
  v_worker_name text;
  v_expense public.expenses%rowtype;
  v_email text;
begin
  if public.is_founder() is not true then
    raise exception 'Founder access is required.' using errcode = '42501';
  end if;

  select * into v_advance from public.advances where id = p_advance_id;
  if not found then
    raise exception 'Advance not found.' using errcode = 'P0002';
  end if;
  if v_advance.status = 'cancelled' then
    raise exception 'A cancelled advance is not a cost.' using errcode = '22023';
  end if;

  select * into v_expense
    from public.expenses
   where source = 'advance' and advance_id = v_advance.id;
  if found then
    return jsonb_build_object('outcome', 'already_posted', 'expense_id', v_expense.id, 'amount', v_expense.amount);
  end if;

  select name into v_worker_name from public.workers where id = v_advance.worker_id;

  perform set_config('app.payroll_posting', 'on', true);

  insert into public.expenses (
    project_id, description, details, category, amount, expense_date,
    source, advance_id, notes, created_by, ai_confirmed
  ) values (
    v_advance.project_id,
    format('Cash advance — %s', coalesce(v_worker_name, 'Worker')),
    format(
      'Cash advance released on %s. Recovered through payroll Bale deductions; the recovery itself is not a second cost.',
      v_advance.date
    ),
    'labor',
    v_advance.amount,
    v_advance.date,
    'advance',
    v_advance.id,
    coalesce(nullif(btrim(v_advance.reason), ''), 'Cash advance'),
    auth.uid(),
    false
  )
  returning * into v_expense;

  select email into v_email from public.users where id = auth.uid();
  insert into public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
  values (auth.uid(), v_email, 'insert', 'expenses', v_expense.id, null, to_jsonb(v_expense));

  return jsonb_build_object('outcome', 'created', 'expense_id', v_expense.id, 'amount', v_expense.amount);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Post (or refresh) one payroll run for one site
-- ---------------------------------------------------------------------------

create or replace function public.post_payroll_expense(
  p_project_id uuid,
  p_period_start date,
  p_period_end date
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_project public.projects%rowtype;
  v_before public.expenses%rowtype;
  v_expense public.expenses%rowtype;
  v_count integer;
  v_gross numeric;
  v_bale numeric;
  v_net numeric;
  v_items jsonb;
  v_description text;
  v_details text;
  v_email text;
  v_had_row boolean := false;
begin
  if public.is_founder() is not true then
    raise exception 'Founder access is required.' using errcode = '42501';
  end if;
  if p_project_id is null or p_period_start is null or p_period_end is null then
    raise exception 'A project site and a payroll period are required.' using errcode = '22023';
  end if;
  if p_period_end < p_period_start then
    raise exception 'Payroll period end must not precede its start.' using errcode = '22023';
  end if;

  select * into v_project from public.projects where id = p_project_id;
  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;

  select count(*),
         coalesce(sum(gross_pay), 0),
         coalesce(sum(bale_deduction), 0),
         coalesce(sum(net_pay), 0)
    into v_count, v_gross, v_bale, v_net
    from public.payroll
   where project_id = p_project_id
     and period_start = p_period_start
     and period_end = p_period_end
     and status = 'paid';

  if v_count = 0 then
    raise exception 'No paid payroll vouchers for this run yet. Mark them paid before posting the cost.'
      using errcode = '22023';
  end if;
  if v_net <= 0 then
    raise exception 'Paid vouchers for this run release ₱0, so there is nothing to post.' using errcode = '22023';
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'name', w.name,
               'quantity', concat_ws(' ', trim_scale(p.days_worked), 'days'),
               'amount', p.gross_pay
             ) order by w.name
           ),
           '[]'::jsonb
         )
    into v_items
    from public.payroll p
    join public.workers w on w.id = p.worker_id
   where p.project_id = p_project_id
     and p.period_start = p_period_start
     and p.period_end = p_period_end
     and p.status = 'paid';

  v_description := format('Payroll — %s', v_project.name);
  v_details := format(
    'Period %s → %s · %s vouchers · Gross ₱%s − Bale recovered ₱%s = Net released ₱%s',
    p_period_start,
    p_period_end,
    v_count,
    to_char(v_gross, 'FM999,999,999,990.00'),
    to_char(v_bale, 'FM999,999,999,990.00'),
    to_char(v_net, 'FM999,999,999,990.00')
  );

  select * into v_before
    from public.expenses
   where source = 'payroll'
     and project_id = p_project_id
     and payroll_period_start = p_period_start
     and payroll_period_end = p_period_end;
  -- Capture FOUND now: the statements below reset it.
  v_had_row := found;

  perform set_config('app.payroll_posting', 'on', true);
  select email into v_email from public.users where id = auth.uid();

  if v_had_row then
    if v_before.amount = v_net
       and v_before.line_items is not distinct from v_items
       and v_before.removed_at is null then
      return jsonb_build_object('outcome', 'unchanged', 'expense_id', v_before.id, 'amount', v_before.amount);
    end if;

    update public.expenses
       set amount = v_net,
           description = v_description,
           details = v_details,
           line_items = v_items,
           removed_at = null
     where id = v_before.id
     returning * into v_expense;

    insert into public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
    values (auth.uid(), v_email, 'update', 'expenses', v_expense.id, to_jsonb(v_before), to_jsonb(v_expense));

    return jsonb_build_object(
      'outcome', 'updated',
      'expense_id', v_expense.id,
      'amount', v_expense.amount,
      'gross', v_gross,
      'bale_recovered', v_bale,
      'net_released', v_net,
      'vouchers', v_count
    );
  end if;

  insert into public.expenses (
    project_id, description, details, line_items, category, amount, expense_date,
    source, payroll_period_start, payroll_period_end, notes, created_by, ai_confirmed
  ) values (
    p_project_id,
    v_description,
    v_details,
    v_items,
    'labor',
    v_net,
    p_period_end,
    'payroll',
    p_period_start,
    p_period_end,
    'Generated from paid payroll vouchers. Amount, project, date and category are locked to payroll.',
    auth.uid(),
    false
  )
  returning * into v_expense;

  insert into public.audit_log (actor_id, actor_email, action, table_name, record_id, before_row, after_row)
  values (auth.uid(), v_email, 'insert', 'expenses', v_expense.id, null, to_jsonb(v_expense));

  return jsonb_build_object(
    'outcome', 'created',
    'expense_id', v_expense.id,
    'amount', v_expense.amount,
    'gross', v_gross,
    'bale_recovered', v_bale,
    'net_released', v_net,
    'vouchers', v_count
  );
end $$;

-- ---------------------------------------------------------------------------
-- 6. Cancelling an advance removes its cost from the ledger
-- ---------------------------------------------------------------------------

create or replace function public.sync_advance_expense_on_cancel()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform set_config('app.payroll_posting', 'on', true);
    update public.expenses
       set removed_at = now(),
           notes = concat_ws(' ', notes, 'Advance cancelled after posting; excluded from labor cost.')
     where source = 'advance'
       and advance_id = new.id
       and removed_at is null;
  end if;
  return new;
end $$;

drop trigger if exists sync_advance_expense_on_cancel on public.advances;
create trigger sync_advance_expense_on_cancel
  after update of status on public.advances
for each row execute function public.sync_advance_expense_on_cancel();

-- ---------------------------------------------------------------------------
-- 7. Permissions
-- ---------------------------------------------------------------------------

-- The atomic-payment migration replaced table-wide UPDATE on payroll with an
-- explicit column list; project_id is new, so add it to that list. Approving or
-- paying a voucher still cannot change it (that migration's trigger covers the
-- financial columns and this one is not among them).
grant update (project_id) on public.payroll to authenticated;

revoke all on function public.post_advance_expense(uuid) from public, anon;
grant execute on function public.post_advance_expense(uuid) to authenticated;

revoke all on function public.post_payroll_expense(uuid, date, date) from public, anon;
grant execute on function public.post_payroll_expense(uuid, date, date) to authenticated;
