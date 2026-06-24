// Vercel Serverless Function - Send a message from the CRM dashboard
// across any supported channel: WhatsApp, Facebook Messenger, or Instagram DM.
//
// Auth via lib/auth.js (X-Dashboard-Key token or secret).
// Honors customer.opted_out (override:true to bypass), caps message length,
// upserts the customer if missing, and always logs the conversation row.
//
// Body:
//   {
//     to:          string,                     // phone for whatsapp; PSID/IGSID for fb/instagram
//     message:     string,
//     customer_id: uuid (optional, preferred when known),
//     platform:    'whatsapp' | 'facebook' | 'instagram'   (default 'whatsapp'),
//     override:    boolean (optional, to bypass opt-out)
//   }

const { isAuthorized } = require('../lib/auth');
const { normalizePhone } = require('../lib/phone');
const { supabaseRequest } = require('../lib/supabase');
const { sendMessengerMessage } = require('../lib/messenger');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID;
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const IG_PAGE_TOKEN = process.env.IG_PAGE_TOKEN;
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

const MAX_MESSAGE_LENGTH = 4096;
const ALLOWED_PLATFORMS = ['whatsapp', 'facebook', 'instagram'];

function setCorsHeaders(res, req) {
  const allowed = [DASHBOARD_ORIGIN, 'https://tilapiya-crm.vercel.app', 'https://tilapiya-crm.netlify.app'].filter(Boolean);
  const reqOrigin = req && req.headers ? req.headers.origin || '' : '';
  const origin = allowed.includes(reqOrigin) ? reqOrigin : (allowed[0] || '*');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dashboard-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// --- WhatsApp: existing send path ---
async function sendWhatsApp(toPhone, message) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    return { error: 'WhatsApp not configured.', status: 500 };
  }
  try {
    var waRes = await fetch('https://graph.facebook.com/v22.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: toPhone, type: 'text',
        text: { body: message }
      })
    });
    var waData = await waRes.json();
    if (!waRes.ok) {
      console.error('WhatsApp send error:', waData);
      return { error: 'WhatsApp API error', details: waData, status: 502 };
    }
    var waMessageId = waData.messages && waData.messages[0] ? waData.messages[0].id : null;
    return { ok: true, messageId: waMessageId, raw: waData };
  } catch (e) {
    return { error: e.message, status: 500 };
  }
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

  var body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Missing JSON body' });
  }

  var to = body.to;
  var message = body.message;
  var customer_id = body.customer_id;
  var override = body.override === true;
  var platform = (body.platform || 'whatsapp').toLowerCase();

  if (ALLOWED_PLATFORMS.indexOf(platform) === -1) {
    return res.status(400).json({ error: 'Invalid platform. Use whatsapp, facebook, or instagram.' });
  }
  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });
  if (typeof message !== 'string') return res.status(400).json({ error: 'message must be a string' });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: 'Message too long (max ' + MAX_MESSAGE_LENGTH + ' characters)' });
  }

  // Normalize `to`: phone for WhatsApp, otherwise leave the PSID/IGSID intact
  var cleanTo = platform === 'whatsapp' ? normalizePhone(to) : String(to).trim();

  try {
    // --- Resolve / upsert customer FIRST so we can honor opt-out and always log ---
    var customer = null;
    if (customer_id) {
      var byId = await supabaseRequest(
        'customers?id=eq.' + encodeURIComponent(customer_id) + '&select=id,opted_out,platform,platform_user_id,phone',
        'GET'
      );
      if (byId && byId[0]) customer = byId[0];
    }
    if (!customer) {
      if (platform === 'whatsapp') {
        var byPhone = await supabaseRequest(
          'customers?phone=eq.' + encodeURIComponent(cleanTo) + '&select=id,opted_out,platform,platform_user_id,phone',
          'GET'
        );
        if (byPhone && byPhone[0]) customer = byPhone[0];
      } else {
        var byPlatform = await supabaseRequest(
          'customers?platform=eq.' + encodeURIComponent(platform) +
          '&platform_user_id=eq.' + encodeURIComponent(cleanTo) +
          '&select=id,opted_out,platform,platform_user_id,phone',
          'GET'
        );
        if (byPlatform && byPlatform[0]) customer = byPlatform[0];
      }
    }
    if (!customer) {
      // Unknown contact - create the customer so the conversation is logged.
      // For IG/FB users we generate a synthetic phone ('ig:<igsid>' / 'fb:<psid>')
      // so the existing UNIQUE(phone) constraint dedupes them.
      var newRow;
      if (platform === 'whatsapp') {
        newRow = {
          phone: cleanTo, name: cleanTo, segment: 'new', reply_mode: 'bot',
          platform: 'whatsapp', last_contact: new Date().toISOString()
        };
      } else {
        var prefix = platform === 'instagram' ? 'ig' : 'fb';
        newRow = {
          phone: prefix + ':' + cleanTo,
          platform: platform, platform_user_id: cleanTo,
          name: platform + ':' + cleanTo, segment: 'new', reply_mode: 'bot',
          last_contact: new Date().toISOString()
        };
      }
      var created = await supabaseRequest('customers?on_conflict=phone', 'POST', newRow,
        { 'Prefer': 'resolution=merge-duplicates,return=representation' });
      if (created && created[0]) customer = created[0];
    }

    // --- Opt-out enforcement ---
    if (customer && customer.opted_out && !override) {
      return res.status(403).json({
        error: 'Customer has opted out of messages. Pass override:true to send anyway.'
      });
    }

    // --- Channel routing ---
    var sendResult;
    if (platform === 'whatsapp') {
      sendResult = await sendWhatsApp(cleanTo, message);
    } else if (platform === 'facebook') {
      if (!FB_PAGE_TOKEN) {
        return res.status(500).json({ error: 'Facebook not configured. Set FB_PAGE_TOKEN.' });
      }
      var fbMsgId = await sendMessengerMessage(FB_PAGE_TOKEN, cleanTo, message);
      sendResult = fbMsgId
        ? { ok: true, messageId: fbMsgId }
        : { error: 'Messenger send failed', status: 502 };
    } else if (platform === 'instagram') {
      if (!IG_PAGE_TOKEN) {
        return res.status(500).json({ error: 'Instagram not configured. Set IG_PAGE_TOKEN.' });
      }
      var igMsgId = await sendMessengerMessage(IG_PAGE_TOKEN, cleanTo, message);
      sendResult = igMsgId
        ? { ok: true, messageId: igMsgId }
        : { error: 'Instagram send failed', status: 502 };
    }

    if (!sendResult || !sendResult.ok) {
      return res.status(sendResult && sendResult.status ? sendResult.status : 500)
        .json({ error: (sendResult && sendResult.error) || 'Send failed', details: sendResult && sendResult.details });
    }

    if (customer && customer.id) {
      var record = {
        customer_id: customer.id, direction: 'outbound', message: message,
        intent: 'manual_reply', platform: platform,
        timestamp: new Date().toISOString()
      };
      if (sendResult.messageId) record.wa_message_id = sendResult.messageId;
      await supabaseRequest('conversations', 'POST', record);
    }

    return res.status(200).json({ status: 'sent', platform: platform, message_id: sendResult.messageId });
  } catch (err) {
    console.error('Send error:', err);
    return res.status(500).json({ error: err.message });
  }
};
