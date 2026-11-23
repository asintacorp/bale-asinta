-- Optional inclusion of vouchers that predate payroll carrying a site.
--
-- post_payroll_expense() only ever summed vouchers stamped with `project_id`,
-- which is right for the automatic path (a payment already knows its site).
-- But it also meant every paid voucher generated before that column existed
-- could never reach the ledger: at the time of writing that was 31 of 31 paid
-- vouchers, so the manual "Post to project costs" action could not post any
-- period before the upgrade.
--
-- The Founder already names the site by hand in that dialog, so this adds an
-- opt-in flag instead of a guess: when `p_include_unsited` is true the function
-- also sums paid vouchers of the period that have no site. The default stays
-- false, so the automatic path after a payment behaves exactly as before, and
-- nothing is ever attributed to a site by inference.
--
-- The expense row states that pre-upgrade vouchers were included, so a later
-- reader can tell how the amount was built.

-- The three-argument version is replaced by one with an optional fourth
-- argument; calls with three arguments still resolve to it.
drop function if exists public.post_payroll_expense(uuid, date, date);

create or replace function public.post_payroll_expense(
  p_project_id uuid,
  p_period_start date,
  p_period_end date,
  p_include_unsited boolean default false
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_project public.projects%rowtype;
  v_before public.expenses%rowtype;
  v_expense public.expenses%rowtype;
  v_count integer;
  v_unsited_count integer;
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
         coalesce(sum(net_pay), 0),
         count(*) filter (where project_id is null)
    into v_count, v_gross, v_bale, v_net, v_unsited_count
    from public.payroll
   where (project_id = p_project_id or (p_include_unsited and project_id is null))
     and period_start = p_period_start
     and period_end = p_period_end
     and status = 'paid';

  if v_count = 0 then
    raise exception 'No paid payroll vouchers for this site and period yet. Mark them paid before posting the cost.'
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
   where (p.project_id = p_project_id or (p_include_unsited and p.project_id is null))
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
  if v_unsited_count > 0 then
    v_details := v_details || format(
      ' · includes %s voucher%s recorded before sites were tracked',
      v_unsited_count,
      case when v_unsited_count = 1 then '' else 's' end
    );
  end if;

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
    -- `details` is compared too: flipping the opt-in changes what the row says
    -- about how it was built even when the money happens to match.
    if v_before.amount = v_net
       and v_before.line_items is not distinct from v_items
       and v_before.details is not distinct from v_details
       and v_before.removed_at is null then
      return jsonb_build_object(
        'outcome', 'unchanged',
        'expense_id', v_before.id,
        'amount', v_before.amount,
        'unsited_vouchers', v_unsited_count
      );
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
      'vouchers', v_count,
      'unsited_vouchers', v_unsited_count
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
    'vouchers', v_count,
    'unsited_vouchers', v_unsited_count
  );
end $$;

revoke all on function public.post_payroll_expense(uuid, date, date, boolean) from public, anon;
grant execute on function public.post_payroll_expense(uuid, date, date, boolean) to authenticated;

-- PostgREST caches function signatures; make it pick up the new one.
notify pgrst, 'reload schema';
