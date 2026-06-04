// Vercel Serverless Function - Send a manual reply from the CRM dashboard.
// Channel-aware: WhatsApp, Facebook Messenger, or Instagram.
// SECURITY unchanged: CORS locked down, X-Dashboard-Key auth required.

const crypto = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID;
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const IG_PAGE_TOKEN = process.env.IG_PAGE_TOKEN || process.env.FB_PAGE_TOKEN;
const GRAPH_VERSION = 'v22.0';
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
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Database not configured.' });
  }

  var to = req.body.to;
  var message = req.body.message;
  var customer_id = req.body.customer_id;
  var platform = req.body.platform || 'whatsapp';
  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });

  try {
    var waMessageId = null;

    if (platform === 'whatsapp') {
      if (!WA_TOKEN || !WA_PHONE_ID) {
        return res.status(500).json({ error: 'WhatsApp not configured.' });
      }
      var cleanTo = to.replace(/\s/g, '');
      var waRes = await fetch('https://graph.facebook.com/' + GRAPH_VERSION + '/' + WA_PHONE_ID + '/messages', {
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
      waMessageId = waData.messages && waData.messages[0] ? waData.messages[0].id : null;

      if (!customer_id) {
        var customers = await supabaseRequest(
          'customers?phone=eq.' + encodeURIComponent(cleanTo) + '&select=id', 'GET'
        );
        if (customers && customers.length > 0) customer_id = customers[0].id;
      }
    } else {
      var token = platform === 'instagram' ? IG_PAGE_TOKEN : FB_PAGE_TOKEN;
      if (!token) return res.status(500).json({ error: 'Page token not configured for ' + platform });
      var mRes = await fetch('https://graph.facebook.com/' + GRAPH_VERSION +
        '/me/messages?access_token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: to },
          messaging_type: 'RESPONSE',
          message: { text: message }
        })
      });
      var mData = await mRes.json();
      if (!mRes.ok) {
        console.error(platform + ' send error:', mData);
        return res.status(500).json({ error: platform + ' API error', details: mData });
      }
    }

    if (customer_id) {
      var record = {
        customer_id: customer_id, direction: 'outbound', message: message,
        intent: 'manual_reply', platform: platform,
        timestamp: new Date().toISOString()
      };
      if (waMessageId) record.wa_message_id = waMessageId;
      await supabaseRequest('conversations', 'POST', record);
    }

    return res.status(200).json({ status: 'sent' });
  } catch (err) {
    console.error('Send error:', err);
    return res.status(500).json({ error: err.message });
  }
};
