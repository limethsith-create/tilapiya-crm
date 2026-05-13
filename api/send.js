// Vercel Serverless Function - Send WhatsApp message from CRM
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID;

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, message, customer_id } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });

  try {
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

    return res.status(200).json({ status: 'sent', wa: waData });
  } catch (err) {
    console.error('Send error:', err);
    return res.status(500).json({ error: err.message });
  }
};
