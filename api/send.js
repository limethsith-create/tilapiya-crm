// Vercel Serverless Function - Send WhatsApp message from CRM
// FIXED: CORS locked down, auth required, auto-lookup customer

const crypto = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID;
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET;

function setCorsHeaders(res, req) {
  const allowed = [DASHBOARD_ORIGIN, 'https://tilapiya-crm.vercel.app', 'https://tilapiya-crm.netlify.app'].filter(Boolean);
  const reqOrigin = req && req.headers ? req.headers.origin || '' : '';
  const origin = allowed.includes(reqOrigin) ? reqOrigin : (allowed[0] || '*');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dashboard-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function isAuthorized(req) {
  if (!DASHBOARD_SECRET) {
    console.error('DASHBOARD_SECRET not set');
    return false;
  }
  var key = req.headers['x-dashboard-key'] || '';
  if (key.length !== DASHBOARD_SECRET.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(DASHBOARD_SECRET));
  } catch (e) { return false; }
}

async function supabaseRequest(path, method, body) {
  var headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
  if (method === 'POST') headers['Prefer'] = 'return=representation';
  var r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: method, headers: headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    var err = await r.text();
    console.error('Supabase error:', path, r.status, err);
    return null;
  }
  var text = await r.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized. Provide X-Dashboard-Key header.' });
  }
  if (!WA_TOKEN || !WA_PHONE_ID) {
    return res.status(500).json({ error: 'WhatsApp not configured.' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Database not configured.' });
  }

  var to = req.body.to;
  var message = req.body.message;
  var customer_id = req.body.customer_id;
  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });

  var cleanTo = to.replace(/\s/g, '');

  try {
    var waRes = await fetch('https://graph.facebook.com/v22.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: cleanTo, type: 'text',
        text: { body: message }
      })
    });
    var waData = await waRes.json();
    if (!waRes.ok) {
      console.error('WhatsApp send error:', waData);
      return res.status(500).json({ error: 'WhatsApp API error', details: waData });
    }

    var waMessageId = waData.messages && waData.messages[0] ? waData.messages[0].id : null;

    // Auto-lookup customer if ID not provided
    var resolvedCustomerId = customer_id;
    if (!resolvedCustomerId) {
      var customers = await supabaseRequest(
        'customers?phone=eq.' + encodeURIComponent(cleanTo) + '&select=id', 'GET'
      );
      if (customers && customers.length > 0) resolvedCustomerId = customers[0].id;
    }
    if (resolvedCustomerId) {
      var record = {
        customer_id: resolvedCustomerId, direction: 'outbound', message: message,
        intent: 'manual_reply', timestamp: new Date().toISOString()
      };
      if (waMessageId) record.wa_message_id = waMessageId;
      await supabaseRequest('conversations', 'POST', record);
    }

    return res.status(200).json({ status: 'sent', wa: waData });
  } catch (err) {
    console.error('Send error:', err);
    return res.status(500).json({ error: err.message });
  }
};
