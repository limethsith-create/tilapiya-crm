// Vercel Serverless Function - Reservations API for POS integration
// POST /api/reservations - Create/update a booking from POS
// GET /api/reservations - Pull bookings (with optional date filter)
// GET /api/reservations?customer_phone=+94... - Get bookings for a customer

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const API_SECRET = process.env.POS_API_SECRET || 'tilapiya_pos_2026';

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Simple API key auth - POS sends this in Authorization header
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

      // Filter by customer phone if provided
      if (customer_phone && data) {
        const phone = customer_phone.replace(/\s/g, '');
        data = data.filter(b => b.customers && b.customers.phone && b.customers.phone.replace(/\s/g, '').includes(phone));
      }

      return res.status(200).json({ bookings: data || [], count: (data || []).length });
    }

    // POST - Create a new reservation from POS
    if (req.method === 'POST') {
      const { customer_name, customer_phone, date, time, party_size, occasion, dietary_notes, payment_status, status, pos_reference } = req.body;

      if (!customer_phone || !date || !time) {
        return res.status(400).json({ error: 'Required fields: customer_phone, date, time' });
      }

      // Upsert customer
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

      // Create booking
      const booking = await supabaseRequest('bookings', 'POST', {
        customer_id: customerId,
        date, time,
        party_size: party_size || 2,
        occasion: occasion || null,
        dietary_notes: dietary_notes || null,
        payment_status: payment_status || 'unpaid',
        status: status || 'pending',
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
      const { booking_id, ...updates } = req.body;
      if (!booking_id) return res.status(400).json({ error: 'Required: booking_id' });

      const result = await supabaseRequest('bookings?id=eq.' + booking_id, 'PATCH', updates);
      return res.status(200).json({ status: 'updated', booking: result && result[0] ? result[0] : null });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Reservations API error:', err);
    return res.status(500).json({ error: err.message });
  }
};
