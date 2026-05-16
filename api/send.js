// Vercel Serverless Function - Send WhatsApp message from CRM
// FIXED: CORS locked down, auth required, better error handling

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID;
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || ''; // e.g. https://tilapiya-crm.netlify.app
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET; // shared secret for dashboard API calls

// --- CORS HELPER (locked down) ---
function setCorsHeaders(res, req) {
  const allowed = [DASHBOARD_ORIGIN, 'https://tilapiya-crm.vercel.app', 'https://tilapiya-crm.netlify.app'].filter(Boolean);
  const reqOrigin = req?.headers?.origin || '';
  const origin = allowed.includes(reqOrigin) ? reqOrigin : allowed[0] || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dashboard-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// --- AUTH CHECK ---
function isAuthorized(req) {
  if (!DASHBOARD_SECRET) {
    console.error('DASHBOARD_SECRET not set — all requests will be rejected');
    return false;
  }
  const key = req.headers['x-dashboard-key'] || '';
  return key === DASHBOARD_SECRET;
}

async function supabaseRequest(path, method, body) {
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
  if (method === 'POST') headers['Prefer'] = 'return=representation';
  const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase error:', path, res.status, err);
    return null;
  }
  return res.json();
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth check
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized. Provide X-Dashboard-Key header.' });
  }

  const { to, message, customer_id } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });

  try {

      // Check WhatsApp config
      if (!WA_TOKEN || !WA_PHONE_ID) {
            console.error('META_WHATSAPP_TOKEN or META_PHONE_NUMBER_ID not set');
            return res.status(500).json({ error: 'WhatsApp not configured. Contact admin.' });
      }
      if (!SUPABASE_URL || !SUPABASE_KEY) {
            return res.status(500).json({ error: 'Database not configured. Contact admin.' });
      }
    const waRes = await fetch('https://graph.facebook.com/v21.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'text',
        text: { body: message }
      })
    });
    const waData = await waRes.json();
    if (!waRes.ok) {
      console.error('WhatsApp send error:', waData);
      return res.status(500).json({ error: 'WhatsApp API error', details: waData });
    }

    if (customer_id) {
      await supabaseRequest('conversations', 'POST', {
        customer_id, direction: 'outbound', message,
        intent: 'manual_reply', timestamp: new Date().toISOString()
      });
    }
