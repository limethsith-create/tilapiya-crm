// Vercel Serverless Function — POS Check-in API for Tilapiya CRM
// Called by external POS system when a customer checks in or places an order.
// Upserts customer, logs the visit/order, updates loyalty, returns summary.
//
// POST /api/pos-checkin  — Register a visit/order (idempotent on pos_reference)
// GET  /api/pos-checkin  — Look up a customer by phone
// Auth: Authorization: Bearer <POS_API_SECRET>

const crypto = require('crypto');
const { normalizePhone } = require('../lib/phone');
const { supabaseRequest } = require('../lib/supabase');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const POS_API_SECRET = process.env.POS_API_SECRET;
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

// --- CORS ---
function setCors(res, req) {
  const allowed = [DASHBOARD_ORIGIN, 'https://tilapiya-crm.vercel.app', 'https://tilapiya-crm.netlify.app'].filter(Boolean);
  const origin = req?.headers?.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0] || '');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// --- AUTH (timing-safe, hash-both-sides so no length leak) ---
function isAuthorized(req) {
  if (!POS_API_SECRET) return false;
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  try {
    const a = crypto.createHash('sha256').update(token).digest();
    const b = crypto.createHash('sha256').update(POS_API_SECRET).digest();
    return crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

// --- SUPABASE HELPER (shared lib, 15s timeout) ---
const supa = supabaseRequest;

// --- LOYALTY TIER LOGIC ---
// Thresholds: Platinum >= 25 visits OR 500 pts, Gold >= 15/300, Silver >= 5/100, Bronze = default
function calculateTier(totalVisits, totalPoints) {
  if (totalVisits >= 25 || totalPoints >= 500) return 'Platinum';
  if (totalVisits >= 15 || totalPoints >= 300) return 'Gold';
  if (totalVisits >= 5 || totalPoints >= 100) return 'Silver';
  return 'Bronze';
}

// --- POINTS LOGIC: 1 point per 100 LKR spent ---
function calculatePoints(orderTotal) {
  if (!orderTotal || orderTotal <= 0) return 0;
  return Math.floor(orderTotal / 100);
}

// --- MAIN HANDLER ---
module.exports = async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  if (!isAuthorized(req)) {
    return res.status(401).json({
      error: 'Unauthorized. Send header: Authorization: Bearer <your_api_key>'
    });
  }

  // Config check
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: Supabase not set' });
  }

  try {
    // =====================================================
    // GET — Look up customer by phone
    // Usage: GET /api/pos-checkin?phone=+94771234567
    // =====================================================
    if (req.method === 'GET') {
      const { phone } = req.query;
      if (!phone) return res.status(400).json({ error: 'Required query param: phone' });

      const cleanPhone = normalizePhone(phone);
      const customers = await supa(
        'customers?phone=eq.' + encodeURIComponent(cleanPhone) +
        '&select=id,phone,name,segment,visit_count,last_contact,notes,email,created_at',
        'GET'
      );

      if (!customers || customers.length === 0) {
        return res.status(404).json({ error: 'Customer not found', phone: cleanPhone });
      }

      const customer = customers[0];

      // Also fetch loyalty info
      const loyalty = await supa(
        'loyalty?customer_id=eq.' + encodeURIComponent(customer.id) + '&select=total_points,total_visits,tier',
        'GET'
      );

      // Also fetch recent visits (order history) for POS display
      const visits = await supa(
        'visits?customer_id=eq.' + encodeURIComponent(customer.id) + '&select=id,order_total,items,pos_reference,visit_type,notes,visited_at&order=visited_at.desc&limit=10',
        'GET'
      );

      // Also fetch upcoming bookings
      const today = new Date().toISOString().slice(0, 10);
      const bookings = await supa(
        'bookings?customer_id=eq.' + encodeURIComponent(customer.id) + '&date=gte.' + today + '&select=id,date,time,party_size,occasion,status,payment_status&order=date.asc&limit=5',
        'GET'
      );

      return res.status(200).json({
        customer: {
          id: customer.id,
          phone: customer.phone,
          name: customer.name,
          segment: customer.segment,
          visit_count: customer.visit_count,
          last_contact: customer.last_contact,
          notes: customer.notes,
          email: customer.email,
          created_at: customer.created_at
        },
        loyalty: loyalty && loyalty[0] ? {
          total_points: loyalty[0].total_points,
          total_visits: loyalty[0].total_visits,
          tier: loyalty[0].tier
        } : { total_points: 0, total_visits: 0, tier: 'Bronze' },
        recent_visits: visits || [],
        upcoming_bookings: bookings || []
      });
    }

    // =====================================================
    // POST — Register a POS visit / order
    // =====================================================
    if (req.method === 'POST') {
      const {
        customer_name,
        customer_phone,
        customer_email,
        order_total,
        items,
        pos_reference,
        notes,
        visit_type // 'dine_in', 'takeaway', 'delivery' — optional
      } = req.body || {};

      // Validate required fields
      if (!customer_phone) {
        return res.status(400).json({
          error: 'Required field: customer_phone',
          example: {
            customer_phone: '+94771234567',
            customer_name: 'John Silva',
            order_total: 3500,
            items: ['Grilled Fish', 'Rice & Curry', 'Lime Juice'],
            pos_reference: 'POS-00123'
          }
        });
      }

      const phone = normalizePhone(customer_phone);
      const now = new Date().toISOString();

      // --- 0. Idempotency: skip if this pos_reference was already recorded ---
      // (Migration 006 adds a partial unique index on visits.pos_reference
      // as a backstop for races.)
      if (pos_reference) {
        const dupes = await supa(
          'visits?pos_reference=eq.' + encodeURIComponent(pos_reference) + '&select=id&limit=1',
          'GET'
        );
        if (dupes && dupes.length > 0) {
          return res.status(200).json({
            status: 'duplicate_ignored',
            pos_reference: pos_reference,
            visit_id: dupes[0].id
          });
        }
      }

      // --- 1. Upsert customer ---
      const existing = await supa(
        'customers?phone=eq.' + encodeURIComponent(phone) + '&select=id,visit_count,segment',
        'GET'
      );

      let customerId;
      let visitCount;
      let isNewCustomer = false;

      if (existing && existing.length > 0) {
        // Existing customer — increment visit count, update last_contact.
        // NOTE: read-modify-write kept deliberately; migration 006 provides an
        // atomic increment_visit(p_customer, p_points) RPC, but this endpoint
        // also needs the tier breakdown for its response, so it still computes
        // loyalty here. Low risk given POS sends one check-in per order.
        customerId = existing[0].id;
        visitCount = (existing[0].visit_count || 0) + 1;

        const updates = {
          visit_count: visitCount,
          last_contact: now
        };
        if (customer_name) updates.name = customer_name;
        if (customer_email) updates.email = customer_email;

        // Auto-segment based on visits
        if (visitCount >= 10) updates.segment = 'vip';
        else if (visitCount >= 5) updates.segment = 'regular';
        else if (visitCount >= 2) updates.segment = 'returning';

        await supa('customers?id=eq.' + encodeURIComponent(customerId), 'PATCH', updates);
      } else {
        // New customer — race-safe merge upsert on unique(phone)
        isNewCustomer = true;
        visitCount = 1;
        const created = await supa('customers?on_conflict=phone', 'POST', {
          phone,
          name: customer_name || phone,
          email: customer_email || null,
          segment: 'new',
          reply_mode: 'bot',
          visit_count: 1,
          last_contact: now,
          notes: notes || null
        }, { 'Prefer': 'resolution=merge-duplicates,return=representation' });
        if (!created || !created[0]) {
          return res.status(500).json({ error: 'Failed to create customer record' });
        }
        customerId = created[0].id;
      }

      // --- 2. Log the visit/order (must succeed before loyalty is awarded) ---
      const visitRecord = {
        customer_id: customerId,
        order_total: order_total || 0,
        items: items || [],
        pos_reference: pos_reference || null,
        visit_type: visit_type || 'dine_in',
        notes: notes || null,
        visited_at: now
      };
      const visitResult = await supa('visits', 'POST', visitRecord);
      if (!visitResult || !visitResult[0]) {
        // Insert may have hit the unique pos_reference backstop (race with a
        // concurrent duplicate request) — check and report gracefully.
        if (pos_reference) {
          const raceDupes = await supa(
            'visits?pos_reference=eq.' + encodeURIComponent(pos_reference) + '&select=id&limit=1',
            'GET'
          );
          if (raceDupes && raceDupes.length > 0) {
            return res.status(200).json({
              status: 'duplicate_ignored',
              pos_reference: pos_reference,
              visit_id: raceDupes[0].id
            });
          }
        }
        return res.status(500).json({ error: 'Failed to record visit — loyalty not awarded' });
      }

      // --- 3. Update loyalty ---
      const pointsEarned = calculatePoints(order_total);

      // Get or create loyalty record
      const loyaltyRows = await supa(
        'loyalty?customer_id=eq.' + encodeURIComponent(customerId) + '&select=id,total_points,total_visits,tier',
        'GET'
      );

      let loyaltyData;
      if (loyaltyRows && loyaltyRows.length > 0) {
        // Update existing loyalty
        const l = loyaltyRows[0];
        const newPoints = (l.total_points || 0) + pointsEarned;
        const newVisits = (l.total_visits || 0) + 1;
        const newTier = calculateTier(newVisits, newPoints);

        await supa('loyalty?id=eq.' + encodeURIComponent(l.id), 'PATCH', {
          total_points: newPoints,
          total_visits: newVisits,
          tier: newTier
        });
        loyaltyData = { total_points: newPoints, total_visits: newVisits, tier: newTier };
      } else {
        // Create loyalty record (race-safe on unique customer_id)
        const newTier = calculateTier(1, pointsEarned);
        await supa('loyalty?on_conflict=customer_id', 'POST', {
          customer_id: customerId,
          total_points: pointsEarned,
          total_visits: 1,
          tier: newTier
        }, { 'Prefer': 'resolution=merge-duplicates,return=representation' });
        loyaltyData = { total_points: pointsEarned, total_visits: 1, tier: newTier };
      }

      // Log loyalty transaction (if points were earned)
      if (pointsEarned > 0) {
        await supa('loyalty_transactions', 'POST', {
          customer_id: customerId,
          points: pointsEarned,
          type: 'earned',
          reason: 'POS order' + (pos_reference ? ' #' + pos_reference : '') +
                  ' — LKR ' + (order_total || 0)
        });
      }

      // --- 4. Return summary ---
      return res.status(201).json({
        status: 'ok',
        is_new_customer: isNewCustomer,
        customer: {
          id: customerId,
          phone: phone,
          name: customer_name || phone,
          visit_count: visitCount,
          segment: isNewCustomer ? 'new' :
                   (visitCount >= 10 ? 'vip' : visitCount >= 5 ? 'regular' :
                    visitCount >= 2 ? 'returning' : 'new')
        },
        loyalty: {
          points_earned: pointsEarned,
          total_points: loyaltyData.total_points,
          total_visits: loyaltyData.total_visits,
          tier: loyaltyData.tier
        },
        visit: {
          order_total: order_total || 0,
          items: items || [],
          pos_reference: pos_reference || null
        }
      });
    }

    return res.status(405).json({ error: 'Method not allowed. Use GET or POST.' });
  } catch (err) {
    console.error('POS check-in error:', err);
    return res.status(500).json({ error: 'Internal server error: ' + err.message });
  }
};
