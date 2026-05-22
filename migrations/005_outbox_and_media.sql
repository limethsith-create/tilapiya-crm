-- Migration 005: Outbox batches, outbox messages, and media messages
-- Run in Supabase SQL Editor
--
-- Adds bulk messaging (outbox) infrastructure and media/voice message
-- tracking for the WhatsApp CRM pipeline.

-- =====================================================================
-- 1. OUTBOX_BATCHES â tracks bulk message campaigns
-- =====================================================================

create table if not exists outbox_batches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  message_template text not null,
  segment text check (segment in ('all', 'new', 'returning', 'vip', 'lapsed', 'gold', 'custom')),
  custom_filter jsonb,
  total_recipients int default 0,
  sent_count int default 0,
  delivered_count int default 0,
  read_count int default 0,
  failed_count int default 0,
  status text default 'draft' check (status in ('draft', 'sending', 'paused', 'completed', 'cancelled')),
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_by text default 'dashboard',
  created_at timestamptz default now()
);

-- Indexes
create index if not exists idx_outbox_batches_status on outbox_batches (status);
create index if not exists idx_outbox_batches_created_at on outbox_batches (created_at desc);

-- RLS â service_role bypasses automatically
alter table outbox_batches enable row level security;

-- =====================================================================
-- 2. OUTBOX_MESSAGES â individual messages within a batch
-- =====================================================================

create table if not exists outbox_messages (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references outbox_batches(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  phone text not null,
  message_text text not null,
  status text default 'queued' check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
  wa_message_id text,
  error_detail text,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  created_at timestamptz default now()
);

-- Indexes
create index if not exists idx_outbox_messages_batch_id on outbox_messages (batch_id);
create index if not exists idx_outbox_messages_customer_id on outbox_messages (customer_id);
create index if not exists idx_outbox_messages_status on outbox_messages (status);
create index if not exists idx_outbox_messages_wa_message_id on outbox_messages (wa_message_id);

-- RLS â service_role bypasses automatically
alter table outbox_messages enable row level security;

-- =====================================================================
-- 3. MEDIA_MESSAGES â processed media from WhatsApp (voice, images, etc.)
-- =====================================================================

create table if not exists media_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  media_type text check (media_type in ('image', 'voice', 'audio', 'video', 'document', 'sticker')),
  wa_media_id text,
  mime_type text,
  transcription text,
  description text,
  detected_language text,
  original_text text,
  translated_text text,
  created_at timestamptz default now()
);

-- Indexes
create index if not exists idx_media_messages_conversation_id on media_messages (conversation_id);
create index if not exists idx_media_messages_customer_id on media_messages (customer_id);
create index if not exists idx_media_messages_media_type on media_messages (media_type);
create index if not exists idx_media_messages_detected_language on media_messages (detected_language);

-- RLS â service_role bypasses automatically
alter table media_messages enable row level security;

-- =====================================================================
-- 4. ALTER EXISTING TABLE â add detected_language to conversations
-- =====================================================================

alter table conversations add column if not exists detected_language text;

create index if not exists idx_conversations_detected_language on conversations (detected_language);

-- =====================================================================
-- 5. RLS POLICIES â anon + authenticated read access (same pattern as 004)
-- =====================================================================

-- Anon read policies (dashboard uses anon key)
create policy "anon_read_outbox_batches" on outbox_batches for select to anon using (true);
create policy "anon_read_outbox_messages" on outbox_messages for select to anon using (true);
create policy "anon_read_media_messages" on media_messages for select to anon using (true);

-- Anon write policies (dashboard creates and updates batches)
create policy "anon_insert_outbox_batches" on outbox_batches for insert to anon with check (true);
create policy "anon_update_outbox_batches" on outbox_batches for update to anon using (true);

-- Authenticated read policies (for future Supabase Auth migration)
create policy "authenticated_read_outbox_batches" on outbox_batches for select to authenticated using (true);
create policy "authenticated_read_outbox_messages" on outbox_messages for select to authenticated using (true);
create policy "authenticated_read_media_messages" on media_messages for select to authenticated using (true);

-- Authenticated write policies
create policy "authenticated_insert_outbox_batches" on outbox_batches for insert to authenticated with check (true);
create policy "authenticated_update_outbox_batches" on outbox_batches for update to authenticated using (true);

-- =====================================================================
-- 6. REALTIME â enable for dashboard subscriptions
-- =====================================================================

alter publication supabase_realtime add table outbox_batches;
alter publication supabase_realtime add table outbox_messages;
alter publication supabase_realtime add table media_messages;

-- =====================================================================
-- DONE
-- =====================================================================
