// Vercel Serverless Function - Send WhatsApp message from CRM
// Auth via lib/auth.js (X-Dashboard-Key token or secret).
// Respects customer opt-out (403 unless override:true), caps message length,
// upserts the customer when missing so the conversation is always logged.

const { isAuthorized } = require('../lib/auth');
const { normalizePhone } = require('../lib/phone');
const { supabaseRequest } = require('../lib/supabase');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID;
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

const MAX_MESSAGE_LENGTH = 4096;

function setCorsHeaders(res, req) {
  const allowed = [DASHBOARD_ORIGIN, 'https://tilapiya-crm.vercel.app', 'https://tilapiya-crm.netlify.app'].filter(Boolean);
  const reqOrigin = req && req.headers ? req.headers.origin || '' : '';
  const origin = allowed.includes(reqOrigin) ? reqOrigin : (allowed[0] || '*');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dashboard-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
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

  var body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Missing JSON body' });
  }

  var to = body.to;
  var message = body.message;
  var customer_id = body.customer_id;
  var override = body.override === true;

  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });
  if (typeof message !== 'string') return res.status(400).json({ error: 'message must be a string' });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: 'Message too long (max ' + MAX_MESSAGE_LENGTH + ' characters)' });
  }

  var cleanTo = normalizePhone(to);

  try {
    // --- Resolve / upsert customer FIRST so we can honor opt-out and always log ---
    var customer = null;
    if (customer_id) {
      var byId = await supabaseRequest(
        'customers?id=eq.' + encodeURIComponent(customer_id) + '&select=id,opted_out', 'GET'
      );
      if (byId && byId[0]) customer = byId[0];
    }
    if (!customer) {
      var byPhone = await supabaseRequest(
        'customers?phone=eq.' + encodeURIComponent(cleanTo) + '&select=id,opted_out', 'GET'
      );
      if (byPhone && byPhone[0]) customer = byPhone[0];
    }
    if (!customer) {
      // Unknown number — create the customer so the conversation is logged
      var created = await supabaseRequest('customers?on_conflict=phone', 'POST', {
        phone: cleanTo, name: cleanTo, segment: 'new', reply_mode: 'bot',
        last_contact: new Date().toISOString()
      }, { 'Prefer': 'resolution=merge-duplicates,return=representation' });
      if (created && created[0]) customer = created[0];
    }

    // --- Opt-out enforcement ---
    if (customer && customer.opted_out && !override) {
      return res.status(403).json({
        error: 'Customer has opted out of messages. Pass override:true to send anyway.'
      });
    }

    var waRes = await fetch('https://graph.facebook.com/v22.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
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

    if (customer && customer.id) {
      var record = {
        customer_id: customer.id, direction: 'outbound', message: message,
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
