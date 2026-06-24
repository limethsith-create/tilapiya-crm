-- TILAPIYA CRM — SUPABASE SCHEMA (FIXED)
-- CHANGES: Locked down RLS, added opted_out, wa_message_id, delivery_status, reply_mode
-- Run in: Supabase SQL Editor
-- NOTE: If upgrading from old schema, use supabase_migration.sql instead

create extension if not exists "pgcrypto";

-- ===================== TABLES =====================

create table customers (
  id uuid primary key default gen_random_uuid(),
  phone text unique not null,
  name text,
  first_contact timestamptz default now(),
  last_contact timestamptz default now(),
  visit_count int default 0,
  segment text default 'new',
  birthday_month int,
  notes text,
  email text,
  reply_mode text default 'bot' check (reply_mode in ('bot', 'manual')),
  opted_out boolean default false,
  created_at timestamptz default now()
);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  date date,
  time time,
  party_size int,
  occasion text,
  dietary_notes text,
  status text default 'pending',
  payment_status text default 'unpaid',
  payment_amount decimal(10,2),
  payment_ref text,
  confirmed_by text,
  sequence_stage text default 'none',
  reminder_sent_at timestamptz,
  pos_reference text,
  created_at timestamptz default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete set null,
  direction text check (direction in ('inbound','outbound')),
  message text,
  intent text,
  wa_message_id text,
  delivery_status text default 'sent',
  timestamp timestamptz,
  created_at timestamptz default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references bookings(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  amount decimal(10,2),
  currency text default 'LKR',
  status text default 'pending',
  payment_ref text,
  method text,
  paid_at timestamptz,
  created_at timestamptz default now()
);

create table crm_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  segment text,
  message_template text,
  sent_count int default 0,
  last_run timestamptz,
  created_at timestamptz default now()
);

create table crm_sends (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references crm_campaigns(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  sent_at timestamptz default now(),
  status text default 'sent'
);

create table templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  body text not null,
  category text,
  created_at timestamptz default now()
);

create table feedback (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  overall_rating int check (overall_rating between 1 and 5),
  food_rating int check (food_rating between 1 and 5),
  service_rating int check (service_rating between 1 and 5),
  ambience_rating int check (ambience_rating between 1 and 5),
  comment text,
  would_recommend boolean,
  collected_via text default 'whatsapp',
  created_at timestamptz default now()
);

create table loyalty (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade unique,
  total_points int default 0,
  total_visits int default 0,
  tier text default 'Bronze' check (tier in ('Bronze', 'Silver', 'Gold', 'Platinum')),
  created_at timestamptz default now()
);

create table rewards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  points_required int not null,
  tier_required text default 'Bronze',
  is_active boolean default true,
  created_at timestamptz default now()
);

create table loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  points int not null,
  type text check (type in ('earned', 'redeemed', 'bonus')),
  reason text,
  created_at timestamptz default now()
);

create table visits (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete cascade,
  order_total decimal(10,2) default 0,
  items jsonb default '[]'::jsonb,
  pos_reference text,
  visit_type text default 'dine_in' check (visit_type in ('dine_in', 'takeaway', 'delivery')),
  notes text,
  visited_at timestamptz default now(),
  created_at timestamptz default now()
);

-- ===================== INDEXES =====================

create index idx_customers_phone on customers (phone);
create index idx_customers_segment on customers (segment);
create index idx_customers_last_contact on customers (last_contact);
create index idx_customers_opted_out on customers (opted_out);
create index idx_bookings_customer_id on bookings (customer_id);
create index idx_bookings_date on bookings (date);
create index idx_bookings_payment_status on bookings (payment_status);
create index idx_bookings_status on bookings (status);
create index idx_conversations_customer_id on conversations (customer_id);
create index idx_conversations_timestamp on conversations (timestamp desc);
create index idx_conversations_wa_message_id on conversations (wa_message_id);
create index idx_payments_booking_id on payments (booking_id);
create index idx_crm_sends_campaign_id on crm_sends (campaign_id);
create index idx_crm_sends_customer_id on crm_sends (customer_id);
create index idx_feedback_customer_id on feedback (customer_id);
create index idx_feedback_created_at on feedback (created_at desc);
create index idx_loyalty_customer_id on loyalty (customer_id);
create index idx_loyalty_tier on loyalty (tier);
create index idx_loyalty_transactions_customer_id on loyalty_transactions (customer_id);
create index idx_rewards_is_active on rewards (is_active);
create index idx_visits_customer_id on visits (customer_id);
create index idx_visits_visited_at on visits (visited_at desc);
create index idx_visits_pos_reference on visits (pos_reference);

-- ===================== ROW LEVEL SECURITY =====================
-- FIXED: No more open anon access. Only service_role (used by Vercel API) can read/write.
-- The dashboard authenticates through the Vercel API layer, NOT directly to Supabase.

alter table customers enable row level security;
alter table bookings enable row level security;
alter table conversations enable row level security;
alter table payments enable row level security;
alter table crm_campaigns enable row level security;
alter table crm_sends enable row level security;
alter table templates enable row level security;
alter table feedback enable row level security;
alter table loyalty enable row level security;
alter table rewards enable row level security;
alter table loyalty_transactions enable row level security;
alter table visits enable row level security;

-- Service role bypasses RLS automatically, so these policies only affect anon/authenticated roles.
-- We DENY all access to anon — everything goes through the Vercel API using service_role key.

-- If you need dashboard to query Supabase directly (legacy), use authenticated role with Supabase Auth:
-- create policy "auth_read_customers" on customers for select to authenticated using (true);
-- For now, all access is through service_role via the API layer.

-- Templates are the only table that can be read by authenticated users (for dashboard template picker)
create policy "authenticated_read_templates" on templates for select to authenticated using (true);

-- ===================== SEED DATA =====================

insert into templates (name, body, category) values
  ('Booking Confirmation', 'Hi {{name}}! Your table for {{party_size}} on {{date}} at {{time}} is confirmed.', 'booking'),
  ('Booking Reminder', 'Hi {{name}}, reminder - reservation tomorrow ({{date}}) at {{time}} for {{party_size}}.', 'booking'),
  ('Payment Request', 'Hi {{name}}! To confirm booking for {{date}} at {{time}}, pay here: {{payment_link}}', 'payment'),
  ('Review Request', 'Hi {{name}}, enjoyed your visit? Leave us a review: {{review_link}}', 'post_visit'),
  ('Win-Back Offer', 'Hi {{name}}, we miss you! 10% off next visit with code WELCOME10. Reply STOP to unsubscribe.', 'crm'),
  ('Birthday Greeting', 'Happy Birthday {{name}}! Book this month for a complimentary dessert. Reply STOP to unsubscribe.', 'crm'),
  ('First Timer Follow-Up', 'Hi {{name}}, loved your first visit? Second visit gets a free starter. Reply STOP to unsubscribe.', 'crm');

insert into rewards (name, description, points_required, tier_required) values
  ('Free Dessert', 'Any dessert on the house', 50, 'Bronze'),
  ('10% Off Dinner', '10% discount on total bill', 150, 'Silver'),
  ('Free Bottle of Wine', 'House wine complimentary', 300, 'Gold'),
  ('Private Dining Experience', '2-hour private room booking', 500, 'Platinum');
