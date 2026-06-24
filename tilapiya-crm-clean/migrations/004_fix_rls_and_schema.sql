-- Migration 004: Fix RLS policies and schema defaults
-- Run in Supabase SQL Editor
--
-- This migration re-enables read access for anon and authenticated roles
-- on all tables. The dashboard (public/index.html) creates a Supabase client
-- with the anon key and queries tables directly, so without these policies
-- every dashboard query returns empty results.
--
-- Also fixes the reply_mode default and adds reference comments.

-- =====================================================================
-- 1. DROP OLD POLICIES (idempotent — safe to re-run)
-- =====================================================================

-- Anon policies (may not exist yet)
DROP POLICY IF EXISTS "anon_read_customers" ON customers;
DROP POLICY IF EXISTS "anon_read_bookings" ON bookings;
DROP POLICY IF EXISTS "anon_read_conversations" ON conversations;
DROP POLICY IF EXISTS "anon_read_payments" ON payments;
DROP POLICY IF EXISTS "anon_read_crm_campaigns" ON crm_campaigns;
DROP POLICY IF EXISTS "anon_read_crm_sends" ON crm_sends;
DROP POLICY IF EXISTS "anon_read_templates" ON templates;
DROP POLICY IF EXISTS "anon_read_feedback" ON feedback;
DROP POLICY IF EXISTS "anon_read_loyalty" ON loyalty;
DROP POLICY IF EXISTS "anon_read_rewards" ON rewards;
DROP POLICY IF EXISTS "anon_read_loyalty_transactions" ON loyalty_transactions;
DROP POLICY IF EXISTS "anon_read_visits" ON visits;
DROP POLICY IF EXISTS "anon_update_bookings" ON bookings;
DROP POLICY IF EXISTS "anon_insert_crm_campaigns" ON crm_campaigns;
DROP POLICY IF EXISTS "anon_update_crm_campaigns" ON crm_campaigns;

-- Authenticated policies (templates policy was created in earlier migration)
DROP POLICY IF EXISTS "authenticated_read_customers" ON customers;
DROP POLICY IF EXISTS "authenticated_read_bookings" ON bookings;
DROP POLICY IF EXISTS "authenticated_read_conversations" ON conversations;
DROP POLICY IF EXISTS "authenticated_read_payments" ON payments;
DROP POLICY IF EXISTS "authenticated_read_crm_campaigns" ON crm_campaigns;
DROP POLICY IF EXISTS "authenticated_read_crm_sends" ON crm_sends;
DROP POLICY IF EXISTS "authenticated_read_templates" ON templates;
DROP POLICY IF EXISTS "authenticated_read_feedback" ON feedback;
DROP POLICY IF EXISTS "authenticated_read_loyalty" ON loyalty;
DROP POLICY IF EXISTS "authenticated_read_rewards" ON rewards;
DROP POLICY IF EXISTS "authenticated_read_loyalty_transactions" ON loyalty_transactions;
DROP POLICY IF EXISTS "authenticated_read_visits" ON visits;
DROP POLICY IF EXISTS "authenticated_update_bookings" ON bookings;
DROP POLICY IF EXISTS "authenticated_insert_crm_campaigns" ON crm_campaigns;
DROP POLICY IF EXISTS "authenticated_update_crm_campaigns" ON crm_campaigns;

-- =====================================================================
-- 2. ANON SELECT POLICIES — dashboard uses anon key for all reads
-- =====================================================================

CREATE POLICY "anon_read_customers" ON customers FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_bookings" ON bookings FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_conversations" ON conversations FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_payments" ON payments FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_crm_campaigns" ON crm_campaigns FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_crm_sends" ON crm_sends FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_templates" ON templates FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_feedback" ON feedback FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_loyalty" ON loyalty FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_rewards" ON rewards FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_loyalty_transactions" ON loyalty_transactions FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_visits" ON visits FOR SELECT TO anon USING (true);

-- Anon write policies — dashboard calls confirmBooking and saveCrmCampaign directly
CREATE POLICY "anon_update_bookings" ON bookings FOR UPDATE TO anon USING (true);
CREATE POLICY "anon_insert_crm_campaigns" ON crm_campaigns FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon_update_crm_campaigns" ON crm_campaigns FOR UPDATE TO anon USING (true);

-- =====================================================================
-- 3. AUTHENTICATED SELECT POLICIES — for future Supabase Auth migration
-- =====================================================================

CREATE POLICY "authenticated_read_customers" ON customers FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_bookings" ON bookings FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_conversations" ON conversations FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_payments" ON payments FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_crm_campaigns" ON crm_campaigns FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_crm_sends" ON crm_sends FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_templates" ON templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_feedback" ON feedback FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_loyalty" ON loyalty FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_rewards" ON rewards FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_loyalty_transactions" ON loyalty_transactions FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read_visits" ON visits FOR SELECT TO authenticated USING (true);

-- Authenticated write policies
CREATE POLICY "authenticated_update_bookings" ON bookings FOR UPDATE TO authenticated USING (true);
CREATE POLICY "authenticated_insert_crm_campaigns" ON crm_campaigns FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "authenticated_update_crm_campaigns" ON crm_campaigns FOR UPDATE TO authenticated USING (true);

-- =====================================================================
-- 4. FIX reply_mode DEFAULT (issue 12)
--    toggle-mode.js removed bot mode; default should be 'manual'
-- =====================================================================

ALTER TABLE customers ALTER COLUMN reply_mode SET DEFAULT 'manual';

-- =====================================================================
-- 5. COLUMN COMMENTS (issues 28, 29)
-- =====================================================================

-- Issue 28: first_contact vs created_at serve similar purposes.
-- first_contact is the timestamp of the customer's first WhatsApp interaction
-- (set by the webhook), while created_at is the row insertion time (set by
-- Postgres default). They will usually be identical for customers created via
-- WhatsApp but may differ for manually-added or imported customers.
COMMENT ON COLUMN customers.first_contact IS
  'First WhatsApp interaction timestamp. Similar to created_at but may differ for manually-added customers.';
COMMENT ON COLUMN customers.created_at IS
  'Row insertion time. See also first_contact for WhatsApp-based first interaction time.';

-- Issue 29: Loyalty tier thresholds used by api/pos-checkin.js for reference:
--   Platinum: totalVisits >= 25 OR totalPoints >= 500
--   Gold:     totalVisits >= 15 OR totalPoints >= 300
--   Silver:   totalVisits >= 5  OR totalPoints >= 100
--   Bronze:   default (below Silver thresholds)
COMMENT ON COLUMN loyalty.tier IS
  'Tier thresholds (pos-checkin.js): Platinum >= 25 visits/500 pts, Gold >= 15/300, Silver >= 5/100, Bronze = default.';

-- =====================================================================
-- DONE
-- =====================================================================
