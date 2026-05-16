// Vercel Serverless Function - Reservations API for POS integration
// FIXED: CORS locked down, no fallback secret, better validation
// POST /api/reservations - Create a booking from POS
// GET /api/reservations - Pull bookings (with optional date filter)
// PATCH /api/reservations - Update a booking

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_SECRET = process.env.POS_API_SECRET; // NO fallback — must be set in env
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

async function supabaseRequest(path, method, body) {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
  if (method === 'POST' || method === 'PATCH') headers['Prefer'] = 'return=representation';
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase error:', path, res.status, err);
    return null;
  }
  const text = await res.text();
  if (!text) return [];
  try { return JSON.parse(text); } catch (e) { return []; }
}

module.exports = async function handler(req, res) {
    const allowed = [DASHBOARD_ORIGIN, 'https://tilapiya-crm.vercel.app', 'https://tilapiya-crm.netlify.app'].filter(Boolean);
    const reqOrigin = req?.headers?.origin || '';
    const origin = allowed.includes(reqOrigin) ? reqOrigin : allowed[0] || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // API key auth — FAIL if not configured
  if (!API_SECRET) {
    console.error('POS_API_SECRET not set in environment variables');
    return res.status(500).json({ error: 'Server misconfigured: API secret not set' });
  }
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  if (token !== API_SECRET) {
    return res.status(401).json({ error: 'Invalid API key. Send Authorization: Bearer <your_key>' });
  }

  try {
    // GET - Pull reservations
    if (req.method === 'GET') {
      const { date, customer_phone, status, limit } = req.query;
      let query = 'bookings?select=*,customers(name,phone)&order=date.desc,time.asc';
      if (date) query += '&date=eq.' + date;
      if (status) query += '&status=eq.' + status;
      if (limit) query += '&limit=' + limit;

      let data = await supabaseRequest(query, 'GET');

      if (customer_phone && data) {
        const phone = customer_phone.replace(/\s/g, '');
        data = data.filter(b => b.customers && b.customers.phone && b.customers.phone.replace(/\s/g, '').includes(phone));
      }

      return res.status(200).json({ bookings: data || [], count: (data || []).length });
    }

    // POST - Create a new reservation from POS
    if (req.method === 'POST') {
      const { customer_name, customer_phone, date, time, party_size, occasion, dietary_notes, payment_status, status: bookingStatus, pos_reference } = req.body;

      if (!customer_phone || !date || !time) {
        return res.status(400).json({ error: 'Required fields: customer_phone, date, time' });
      }

      const existing = await supabaseRequest('customers?phone=eq.' + encodeURIComponent(customer_phone) + '&select=id', 'GET');
      let customerId;
      if (existing && existing.length > 0) {
        customerId = existing[0].id;
        await supabaseRequest('customers?id=eq.' + customerId, 'PATCH', {
          last_contact: new Date().toISOString(),
          name: customer_name || undefined
        });
      } else {
        const created = await supabaseRequest('customers', 'POST', {
          phone: customer_phone, name: customer_name || customer_phone, segment: 'new'
        });
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
      const { booking_id, date, time, party_size, occasion, dietary_notes, payment_status, status: bookingStatus, pos_reference, payment_amount, payment_ref, confirmed_by } = req.body;
      if (!booking_id) return res.status(400).json({ error: 'Required: booking_id' });

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

      const result = await supabaseRequest('bookings?id=eq.' + booking_id, 'PATCH', updates);
      return res.status(200).json({ status: 'updated', booking: result && result[0] ? result[0] : null });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Reservations API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
