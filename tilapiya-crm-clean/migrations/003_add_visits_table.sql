-- Migration 003: Add visits table for POS check-in tracking
-- Run in Supabase SQL Editor
-- This table stores every POS visit/order for a customer

-- Create visits table
create table if not exists visits (
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

-- Indexes
create index if not exists idx_visits_customer_id on visits (customer_id);
create index if not exists idx_visits_visited_at on visits (visited_at desc);
create index if not exists idx_visits_pos_reference on visits (pos_reference);

-- RLS — same pattern as other tables: service_role only
alter table visits enable row level security;

-- Enable realtime for visits table (so dashboard can subscribe)
alter publication supabase_realtime add table visits;
