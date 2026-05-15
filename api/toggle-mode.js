// Vercel Serverless Function - Toggle bot/manual reply mode for a customer
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { customer_id, mode } = req.body;
  if (!customer_id || !mode) return res.status(400).json({ error: 'Missing customer_id or mode' });
  if (mode !== 'bot' && mode !== 'manual') return res.status(400).json({ error: 'mode must be "bot" or "manual"' });

  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/customers?id=eq.' + customer_id, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ reply_mode: mode })
    });
    if (!r.ok) {
      const err = await r.text();
      return res.status(500).json({ error: 'Supabase error', details: err });
    }
    const data = await r.json();
    return res.status(200).json({ status: 'ok', mode, customer: data[0] || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
