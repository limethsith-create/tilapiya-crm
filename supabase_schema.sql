-- RESTAURANT CHATBOT CRM -- SUPABASE SCHEMA
-- Run in: Supabase SQL Editor

create extension if not exists "pgcrypto";

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
  created_at timestamptz default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id) on delete set null,
  direction text check (direction in ('inbound','outbound')),
  message text,
  intent text,
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

create index on customers (phone);
create index on customers (segment);
create index on customers (last_contact);
create index on bookings (customer_id);
create index on bookings (date);
create index on bookings (payment_status);
create index on bookings (status);
create index on conversations (customer_id);
create index on conversations (timestamp desc);
create index on payments (booking_id);
create index on crm_sends (campaign_id);
create index on crm_sends (customer_id);

alter table customers enable row level security;
alter table bookings enable row level security;
alter table conversations enable row level security;
alter table payments enable row level security;
alter table crm_campaigns enable row level security;
alter table crm_sends enable row level security;
alter table templates enable row level security;

create policy "anon_read_customers" on customers for select to anon using (true);
create policy "anon_read_bookings" on bookings for select to anon using (true);
create policy "anon_read_conversations" on conversations for select to anon using (true);
create policy "anon_read_payments" on payments for select to anon using (true);
create policy "anon_read_campaigns" on crm_campaigns for select to anon using (true);
create policy "anon_read_sends" on crm_sends for select to anon using (true);
create policy "anon_read_templates" on templates for select to anon using (true);
create policy "anon_update_bookings" on bookings for update to anon using (true);
create policy "anon_insert_templates" on templates for insert to anon with check (true);
create policy "anon_update_templates" on templates for update to anon using (true);

insert into templates (name, body, category) values
  ('Booking Confirmation', 'Hi {{name}}! Your table for {{party_size}} on {{date}} at {{time}} is confirmed.', 'booking'),
  ('Booking Reminder', 'Hi {{name}}, reminder - reservation tomorrow ({{date}}) at {{time}} for {{party_size}}.', 'booking'),
  ('Payment Request', 'Hi {{name}}! To confirm booking for {{date}} at {{time}}, pay here: {{payment_link}}', 'payment'),
  ('Review Request', 'Hi {{name}}, enjoyed your visit? Leave us a review: {{review_link}}', 'post_visit'),
  ('Win-Back Offer', 'Hi {{name}}, we miss you! 10% off next visit with code WELCOME10.', 'crm'),
  ('Birthday Greeting', 'Happy Birthday {{name}}! Book this month for a complimentary dessert.', 'crm'),
  ('First Timer Follow-Up', 'Hi {{name}}, loved your first visit? Second visit gets a free starter.', 'crm');
