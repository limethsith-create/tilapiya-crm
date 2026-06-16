// Vercel Serverless Function - Reservations API for POS integration
// POST /api/reservations - Create a booking from POS
// GET /api/reservations - Pull bookings (with optional date filter)
// PATCH /api/reservations - Update a booking
// Auth: Authorization: Bearer <POS_API_SECRET> (POS), or a valid
// X-Dashboard-Key (dashboard token / secret, see lib/auth.js).

const crypto = require('crypto');
const { normalizePhone } = require('../lib/phone');
const { supabaseRequest } = require('../lib/supabase');
const dashboardAuth = require('../lib/auth');

const API_SECRET = process.env.POS_API_SECRET; // NO fallback — must be set in env
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_RE = /^[a-z_]+$/;

// --- TIMING-SAFE POS AUTH (hash both sides, no length leak) ---
function isPosAuthorized(req) {
  if (!API_SECRET) {
    console.error('POS_API_SECRET not set in environment variables');
    return false;
  }
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  try {
    const a = crypto.createHash('sha256').update(token).digest();
    const b = crypto.createHash('sha256').update(API_SECRET).digest();
    return crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

function isAuthorized(req) {
  return isPosAuthorized(req) || dashboardAuth.isAuthorized(req);
}

module.exports = async function handler(req, res) {
  const allowed = [DASHBOARD_ORIGIN, 'https://tilapiya-crm.vercel.app', 'https://tilapiya-crm.netlify.app'].filter(Boolean);
  const reqOrigin = req?.headers?.origin || '';
  const origin = allowed.includes(reqOrigin) ? reqOrigin : allowed[0] || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Dashboard-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // API key auth — timing-safe
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Invalid API key. Send Authorization: Bearer <your_key>' });
  }

  try {
    // GET - Pull reservations
    if (req.method === 'GET') {
      const { date, customer_phone, status, limit } = req.query;

      let query = 'bookings?select=*,customers(name,phone)&order=date.desc,time.asc';

      if (date) {
        if (!DATE_RE.test(date)) return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
        query += '&date=eq.' + encodeURIComponent(date);
      }
      if (status) {
        if (!STATUS_RE.test(status)) return res.status(400).json({ error: 'Invalid status filter' });
        query += '&status=eq.' + encodeURIComponent(status);
      }

      let limitN = 200;
      if (limit !== undefined) {
        limitN = parseInt(limit, 10);
        if (!Number.isFinite(limitN) || limitN < 1 || limitN > 200) {
          return res.status(400).json({ error: 'Invalid limit. Must be an integer between 1 and 200' });
        }
      }
      query += '&limit=' + limitN;

      // customer_phone: resolve customer by normalized phone, filter by
      // customer_id (indexed) instead of scanning/filtering all bookings.
      if (customer_phone) {
        const phone = normalizePhone(customer_phone);
        const custRows = await supabaseRequest(
          'customers?phone=eq.' + encodeURIComponent(phone) + '&select=id', 'GET'
        );
        if (!custRows || custRows.length === 0) {
          return res.status(200).json({ bookings: [], count: 0 });
        }
        query += '&customer_id=eq.' + encodeURIComponent(custRows[0].id);
      }

      const data = await supabaseRequest(query, 'GET');
      return res.status(200).json({ bookings: data || [], count: (data || []).length });
    }

    // POST - Create a new reservation from POS
    if (req.method === 'POST') {
      const { customer_name, customer_phone, date, time, party_size, occasion, dietary_notes, payment_status, status: bookingStatus, pos_reference } = req.body || {};

      if (!customer_phone || !date || !time) {
        return res.status(400).json({ error: 'Required fields: customer_phone, date, time' });
      }
      if (!DATE_RE.test(date)) {
        return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
      }

      const normalizedPhone = normalizePhone(customer_phone);

      const existing = await supabaseRequest('customers?phone=eq.' + encodeURIComponent(normalizedPhone) + '&select=id', 'GET');
      let customerId;
      if (existing && existing.length > 0) {
        customerId = existing[0].id;
        await supabaseRequest('customers?id=eq.' + encodeURIComponent(customerId), 'PATCH', {
          last_contact: new Date().toISOString(),
          name: customer_name || undefined
        });
      } else {
        // Race-safe create via merge upsert on unique(phone)
        const created = await supabaseRequest('customers?on_conflict=phone', 'POST', {
          phone: normalizedPhone,
          name: customer_name || normalizedPhone,
          segment: 'new',
          reply_mode: 'bot'
        }, { 'Prefer': 'resolution=merge-duplicates,return=representation' });
        customerId = created && created[0] ? created[0].id : null;
      }

      if (!customerId) return res.status(500).json({ error: 'Failed to create customer' });

      const booking = await supabaseRequest('bookings', 'POST', {
        customer_id: customerId,
        date, time,
        party_size: party_size || 2,
        occasion: occasion || null,
        dietary_notes: dietary_notes || null,
        payment_status: payment_status || 'unpaid',
        status: bookingStatus || 'pending',
        pos_reference: pos_reference || null,
        created_at: new Date().toISOString()
      });

      return res.status(201).json({
        status: 'created',
        booking: booking && booking[0] ? booking[0] : null,
        customer_id: customerId
      });
    }

    // PATCH - Update a reservation
    if (req.method === 'PATCH') {
      const { booking_id, date, time, party_size, occasion, dietary_notes, payment_status, status: bookingStatus, pos_reference, payment_amount, payment_ref, confirmed_by } = req.body || {};
      if (!booking_id) return res.status(400).json({ error: 'Required: booking_id' });
      if (!UUID_RE.test(String(booking_id))) {
        return res.status(400).json({ error: 'Invalid booking_id (must be a UUID)' });
      }
      if (date !== undefined && !DATE_RE.test(String(date))) {
        return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
      }

      // Whitelist allowed fields — never allow customer_id or id to be changed
      const updates = {};
      if (date !== undefined) updates.date = date;
      if (time !== undefined) updates.time = time;
      if (party_size !== undefined) updates.party_size = party_size;
      if (occasion !== undefined) updates.occasion = occasion;
      if (dietary_notes !== undefined) updates.dietary_notes = dietary_notes;
      if (payment_status !== undefined) updates.payment_status = payment_status;
      if (bookingStatus !== undefined) updates.status = bookingStatus;
      if (pos_reference !== undefined) updates.pos_reference = pos_reference;
      if (payment_amount !== undefined) updates.payment_amount = payment_amount;
      if (payment_ref !== undefined) updates.payment_ref = payment_ref;
      if (confirmed_by !== undefined) updates.confirmed_by = confirmed_by;

      if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

      const result = await supabaseRequest('bookings?id=eq.' + encodeURIComponent(booking_id), 'PATCH', updates);
      if (!result || result.length === 0) {
        return res.status(404).json({ error: 'Booking not found' });
      }
      return res.status(200).json({ status: 'updated', booking: result[0] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Reservations API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
