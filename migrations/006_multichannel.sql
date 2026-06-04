-- Migration 006: Multi-channel support (Instagram + Facebook Messenger)
-- Safe to run multiple times. Run in: Supabase SQL Editor.
-- Adds a `platform` dimension so Instagram/Facebook senders (which have a
-- page-scoped user ID, NOT a phone number) live alongside WhatsApp customers.

begin;

-- 1) customers: add platform + platform_user_id, make phone optional
alter table customers add column if not exists platform text default 'whatsapp';
alter table customers add column if not exists platform_user_id text;

-- backfill existing rows (all current customers are WhatsApp)
update customers set platform = 'whatsapp' where platform is null;
update customers
  set platform_user_id = phone
  where platform_user_id is null and phone is not null;

-- IG/FB users have no phone number, so phone can no longer be required.
-- (The existing UNIQUE on phone still holds for WhatsApp; multiple NULLs are allowed.)
alter table customers alter column phone drop not null;

-- one identity per (channel, channel user id)
create unique index if not exists idx_customers_platform_user
  on customers (platform, platform_user_id);

-- 2) conversations: tag each message with the channel it came in/out on
alter table conversations add column if not exists platform text default 'whatsapp';
update conversations set platform = 'whatsapp' where platform is null;
create index if not exists idx_conversations_platform on conversations (platform);

commit;
