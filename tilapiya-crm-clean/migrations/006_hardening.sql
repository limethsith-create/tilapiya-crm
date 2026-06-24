-- =====================================================================
-- Migration 006: Hardening
-- Run in Supabase SQL Editor AFTER migration 005 (005_outbox_and_media.sql).
-- Idempotent — safe to re-run.
--
-- What this fixes (per the 2026-06 security/correctness audit):
--   1. Drops ALL anon_* RLS policies — the dashboard no longer reads
--      Supabase with the anon key; it goes through /api/data (service role).
--   2. Unique partial index on conversations.wa_message_id (dedupes first)
--      so the webhook's idempotency claim (ignore-duplicates upsert) works.
--   3. Unique partial index on visits.pos_reference (dedupes first) as the
--      backstop for POS check-in idempotency.
--   4. Widens outbox_messages.status check to include 'cancelled' and
--      outbox_batches.segment check to include 'regular'.
--   5. Adds outbox_messages.customer_name (used by the outbox UI).
--   6. Adds media_messages columns the API writes: wa_message_id,
--      file_size, original_filename, processed_at.
--   7. Adds an atomic increment_visit(p_customer, p_points) RPC
--      (security definer, service_role-only).
--   8. Adds check constraints on bookings.status / bookings.payment_status
--      covering every value written by the API, dashboard, and n8n flows
--      (NOT VALID so pre-existing rows never block the migration).
--   9. Idempotent realtime publication membership for outbox/media tables.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. DROP ALL anon_* POLICIES (dashboard now uses the /api/data proxy)
-- ---------------------------------------------------------------------
do $$
declare
  pol record;
begin
  for pol in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and policyname like 'anon\_%' escape '\'
  loop
    execute format('drop policy if exists %I on %I.%I',
                   pol.policyname, pol.schemaname, pol.tablename);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. UNIQUE PARTIAL INDEX: conversations.wa_message_id
--    Dedupe first (keep the row with the smallest id per wa_message_id),
--    then create the index. Required for the webhook idempotency claim.
-- ---------------------------------------------------------------------
delete from conversations a
using conversations b
where a.wa_message_id is not null
  and a.wa_message_id = b.wa_message_id
  and a.id > b.id;

create unique index if not exists uq_conversations_wa_message_id
  on conversations (wa_message_id)
  where wa_message_id is not null;

-- ---------------------------------------------------------------------
-- 3. UNIQUE PARTIAL INDEX: visits.pos_reference (POS idempotency backstop)
-- ---------------------------------------------------------------------
delete from visits a
using visits b
where a.pos_reference is not null
  and a.pos_reference = b.pos_reference
  and a.id > b.id;

create unique index if not exists uq_visits_pos_reference
  on visits (pos_reference)
  where pos_reference is not null;

-- ---------------------------------------------------------------------
-- 4. WIDEN CHECK CONSTRAINTS
-- ---------------------------------------------------------------------
-- outbox_messages.status: add 'cancelled' (cancel_batch + opt-out skips)
alter table outbox_messages drop constraint if exists outbox_messages_status_check;
alter table outbox_messages add constraint outbox_messages_status_check
  check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled'));

-- outbox_batches.segment: add 'regular' (used by api/outbox.js segments)
alter table outbox_batches drop constraint if exists outbox_batches_segment_check;
alter table outbox_batches add constraint outbox_batches_segment_check
  check (segment in ('all', 'new', 'returning', 'regular', 'vip', 'lapsed', 'gold', 'custom'));

-- ---------------------------------------------------------------------
-- 5. outbox_messages.customer_name (resolved name snapshot for the UI)
-- ---------------------------------------------------------------------
alter table outbox_messages add column if not exists customer_name text;

-- ---------------------------------------------------------------------
-- 6. media_messages: columns written by api/webhook.js and api/media.js
-- ---------------------------------------------------------------------
alter table media_messages add column if not exists wa_message_id text;
alter table media_messages add column if not exists file_size bigint;
alter table media_messages add column if not exists original_filename text;
alter table media_messages add column if not exists processed_at timestamptz;

create index if not exists idx_media_messages_wa_message_id
  on media_messages (wa_message_id);

-- ---------------------------------------------------------------------
-- 7. RPC: increment_visit(p_customer, p_points)
--    Atomically bumps customers.visit_count and upserts the loyalty row
--    (points, visits, recomputed tier). service_role-only.
-- ---------------------------------------------------------------------
create or replace function increment_visit(p_customer uuid, p_points int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_points int;
  v_visits int;
  v_tier text;
begin
  update customers
     set visit_count = coalesce(visit_count, 0) + 1,
         last_contact = now()
   where id = p_customer;

  insert into loyalty (customer_id, total_points, total_visits)
  values (p_customer, greatest(coalesce(p_points, 0), 0), 1)
  on conflict (customer_id) do update
    set total_points = coalesce(loyalty.total_points, 0) + greatest(coalesce(p_points, 0), 0),
        total_visits = coalesce(loyalty.total_visits, 0) + 1
  returning total_points, total_visits into v_points, v_visits;

  v_tier := case
    when v_visits >= 25 or v_points >= 500 then 'Platinum'
    when v_visits >= 15 or v_points >= 300 then 'Gold'
    when v_visits >= 5  or v_points >= 100 then 'Silver'
    else 'Bronze'
  end;

  update loyalty set tier = v_tier where customer_id = p_customer;
end;
$$;

revoke all on function increment_visit(uuid, int) from public;
revoke all on function increment_visit(uuid, int) from anon;
revoke all on function increment_visit(uuid, int) from authenticated;
grant execute on function increment_visit(uuid, int) to service_role;

-- ---------------------------------------------------------------------
-- 8. CHECK CONSTRAINTS: bookings.status / bookings.payment_status
--    Values verified against code:
--      status: 'pending' (reservations.js default, phase1), 'confirmed'
--              (dashboard, phase3 filter), 'cancelled' (dashboard badge),
--              'expired' (phase2 reminders), 'completed' (post-visit).
--      payment_status: 'unpaid' (default, phase1), 'pending', 'awaiting'
--              (dashboard pipeline), 'review' (payment-slip review),
--              'paid' (dashboard), 'refunded', 'expired' (dashboard badge).
--    NOT VALID: enforced for new writes only, so legacy rows never block
--    this migration. Run "alter table bookings validate constraint ..."
--    later after cleaning historic data if full validation is wanted.
-- ---------------------------------------------------------------------
alter table bookings drop constraint if exists bookings_status_check;
alter table bookings add constraint bookings_status_check
  check (status in ('pending', 'confirmed', 'cancelled', 'expired', 'completed'))
  not valid;

alter table bookings drop constraint if exists bookings_payment_status_check;
alter table bookings add constraint bookings_payment_status_check
  check (payment_status in ('unpaid', 'pending', 'awaiting', 'review', 'paid', 'refunded', 'expired'))
  not valid;

-- ---------------------------------------------------------------------
-- 9. REALTIME PUBLICATION (idempotent — 005's adds fail when re-run)
-- ---------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table outbox_batches;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table outbox_messages;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table media_messages;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table visits;
exception
  when duplicate_object then null;
end $$;

-- =====================================================================
-- DONE
-- =====================================================================
