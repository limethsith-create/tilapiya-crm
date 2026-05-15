// Vercel Serverless Function - Toggle bot/manual reply mode for a customer
// FIXED: CORS locked down, auth required

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET;

function setCorsHeaders(res, req) {
  const allowed = [DASHBOARD_ORIGIN, 'https://tilapiya-crm.vercel.app', 'https://tilapiya-crm.netlify.app'].filter(Boolean);
  const reqOrigin = req?.headers?.origin || '';
  const origin = allowed.includes(reqOrigin) ? reqOrigin : allowed[0] || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dashboard-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function isAuthorized(req) {
  if (!DASHBOARD_SECRET) return false;
  const key = req.headers['x-dashboard-key'] || '';
  return key === DASHBOARD_SECRET;
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized. Provide X-Dashboard-Key header.' });
  }

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
    const d