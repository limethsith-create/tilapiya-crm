-- =====================================================================
-- Migration 007: Multi-channel (WhatsApp + Facebook Messenger + Instagram)
-- Run in Supabase SQL Editor AFTER migration 006_hardening.sql.
-- Idempotent — safe to re-run.
--
-- DESIGN NOTES:
--   - customers.phone stays UNIQUE NOT NULL.
--   - For Instagram users we store phone as 'ig:<igsid>'.
--   - For Facebook users we store phone as 'fb:<psid>'.
--     That keeps the existing on_conflict=phone upsert path working for
--     every channel and avoids partial-unique-index quirks in PostgREST.
--   - Two new columns track channel routing: platform + platform_user_id.
--   - conversations also gets a platform column so the inbox can filter
--     directly without joining to customers.
--   - Everything backfills to platform='whatsapp' so existing rows are
--     visible in the WhatsApp tab and on the All-Channels view.
-- =====================================================================

-- 1. CUSTOMERS columns ----------------------------------------------------
alter table customers add column if not exists platform text;
alter table customers add column if not exists platform_user_id text;

update customers set platform = 'whatsapp' where platform is null;
alter table customers alter column platform set default 'whatsapp';
alter table customers alter column platform set not null;

alter table customers drop constraint if exists customers_platform_check;
alter table customers add constraint customers_platform_check
  check (platform in ('whatsapp', 'facebook', 'instagram'))
  not valid;

-- 2. CONVERSATIONS column -------------------------------------------------
alter table conversations add column if not exists platform text;
update conversations set platform = 'whatsapp' where platform is null;
alter table conversations alter column platform set default 'whatsapp';
alter table conversations alter column platform set not null;

alter table conversations drop constraint if exists conversations_platform_check;
alter table conversations add constraint conversations_platform_check
  check (platform in ('whatsapp', 'facebook', 'instagram'))
  not valid;

-- 3. SUPPORTING INDEXES ---------------------------------------------------
create index if not exists idx_customers_platform on customers (platform);
create index if not exists idx_customers_platform_user_id on customers (platform_user_id);
create index if not exists idx_conversations_platform on conversations (platform);

-- =====================================================================
-- DONE
-- After running this you can deploy the Instagram + Facebook webhooks
-- and the multi-channel send.js update. The dashboard is already wired
-- to filter by platform and to render channel badges.
-- =====================================================================
