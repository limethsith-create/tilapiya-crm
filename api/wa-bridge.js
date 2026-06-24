// Vercel Serverless Function — Tilapiya CRM WhatsApp Web bridge ingest endpoint.
//
// The bridge (whatsapp-bridge/, running on a computer with WhatsApp Web linked
// to the restaurant's phone) POSTs every inbound customer message here. We run
// it through the Groq restaurant brain, save the
// whole conversation into Supabase, and return the reply text. The bridge then
// sends that reply back over WhatsApp Web — no Meta Cloud API needed.
//
// Secured with a shared secret (BRIDGE_SECRET) sent as a Bearer token, so only
// your bridge can post messages. If BRIDGE_SECRET is unset, falls back to a
// baked-in default so it works with zero env setup. Override in Vercel for
// production.

const crypto = require('crypto');
const { normalizePhone } = require('../lib/phone');
const { supabaseRequest } = require('../lib/supabase');

// AI engine: Groq (OpenAI-compatible API). Set GROQ_API_KEY in Vercel.
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const DEFAULT_BRIDGE_SECRET = '0ed3044a61fc16eb2d599bae52f3d75849987e768520dd72';

// ---- Tilapiya restaurant brain (same as api/webhook.js) ---------------------
const RESTAURANT_CONTEXT = [
  'You are the friendly WhatsApp assistant for Tilapiya — a popular Sri Lankan restaurant.',
  'You help customers with menu info, bookings, location, hours, and general questions.',
  '',
  'KEY DETAILS:',
  '- Restaurant Name: Tilapiya',
  '- Cuisine: Sri Lankan & fusion dishes, seafood specialties',
  '- Specialties: Fresh tilapia dishes, Sri Lankan rice & curry, seafood platters, kottu, hoppers',
  '- Atmosphere: Casual dining, family-friendly, karaoke nights available',
  '- Payment: Cash, card, and bank transfer accepted (LKR)',
  '',
  'BOOKING POLICY:',
  '- Reservations recommended for groups of 4+',
  '- Private dining & karaoke rooms available (must book in advance)',
  '- Cancellations: Please notify at least 2 hours before',
  '',
  'LANGUAGE RULES (CRITICAL):',
  '- DETECT the language of the customer message (Sinhala/සිංහල, Tamil/தமிழ், or English)',
  '- ALWAYS respond in the SAME language the customer writes in',
  '- If the customer writes in Sinhala, respond entirely in Sinhala',
  '- If the customer writes in Tamil, respond entirely in Tamil',
  '- If the customer writes in English, respond in English',
  '- If the message is mixed, prefer the dominant language',
  '',
  'BEHAVIOR RULES:',
  '- Be warm, friendly, and concise — this is WhatsApp, keep messages short',
  '- Use a casual but professional tone',
  '- If you do not know something specific (like exact prices), say you will check and a team member will follow up',
  '- For complaints, be empathetic, apologize, and say a manager will reach out personally',
  '- Never make up prices, hours, or menu items you are not sure about',
  '- If someone wants to make a booking, collect: date, time, party size, and any special occasion',
  '- Use emojis sparingly but warmly',
  '- Maximum response length: 3-4 short sentences for simple queries'
].join('\n');

// ---- Constant-time auth check ----------------------------------------------
function authorized(req) {
  const secret = process.env.BRIDGE_SECRET || DEFAULT_BRIDGE_SECRET;
  const header = (req.headers && req.headers['authorization']) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (token.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= token.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

// ---- Customer upsert keyed on phone ----------------------------------------
async function upsertCustomer(phone, name) {
  const existing = await supabaseRequest(
    'customers?phone=eq.' + encodeURIComponent(phone) + '&select=id,phone,name,segment,visit_count,reply_mode,opted_out',
    'GET'
  );
  if (existing && existing.length > 0) {
    await supabaseRequest('customers?id=eq.' + existing[0].id, 'PATCH', {
      last_contact: new Date().toISOString(),
      name: name || existing[0].name
    });
    return existing[0];
  }
  const created = await supabaseRequest('customers?on_conflict=phone', 'POST', {
    phone: phone,
    name: name || phone,
    segment: 'new',
    reply_mode: 'bot',
    platform: 'whatsapp',
    last_contact: new Date().toISOString()
  }, { 'Prefer': 'resolution=merge-duplicates,return=representation' });
  return created && created[0] ? created[0] : null;
}

// ---- Save a conversation row (inbound or outbound) -------------------------
async function saveMessage(customerId, message, direction, intent) {
  return supabaseRequest('conversations', 'POST', {
    customer_id: customerId,
    direction: direction,
    message: message,
    intent: intent || 'general',
    platform: 'whatsapp',
    timestamp: new Date().toISOString()
  });
}

// ---- Intent detection (mirrors webhook.js) ---------------------------------
function detectIntent(text) {
  const lower = (text || '').toLowerCase();
  if (/menu|food|dish|eat|price|cost|how much/.test(lower)) return 'MENU';
  if (/book|reserv|table|party|event|private|karaoke/.test(lower)) return 'BOOKING';
  if (/where|location|address|direction|map/.test(lower)) return 'LOCATION';
  if (/complain|bad|terrible|worst|disappoint|angry|upset|rude|poor|refund/.test(lower)) return 'COMPLAINT';
  if (/thank|thanks|cheers|appreciate/.test(lower)) return 'THANKS';
  if (/^(hi|hello|hey|howdy|good morning|good evening|good afternoon)/.test(lower)) return 'GREETING';
  return 'GENERAL';
}

// ---- Recent conversation history for context -------------------------------
async function getHistory(customerId, limit) {
  const rows = await supabaseRequest(
    'conversations?customer_id=eq.' + encodeURIComponent(customerId) +
    '&select=direction,message,timestamp&order=timestamp.desc&limit=' + (limit || 10),
    'GET'
  );
  if (!rows || rows.length === 0) return [];
  return rows.reverse().map(r => ({
    role: r.direction === 'inbound' ? 'user' : 'assistant',
    content: r.message
  }));
}

// ---- Generate AI reply via Groq --------------------------------------------
async function generateReply(text, history, customer, intent) {
  if (!GROQ_API_KEY) {
    console.error('[wa-bridge] GROQ_API_KEY not set');
    return null;
  }
  const customerInfo =
    'Customer: ' + (customer.name || 'Unknown') +
    ' | Visits: ' + (customer.visit_count || 0) +
    ' | Segment: ' + (customer.segment || 'new') +
    ' | Detected intent: ' + intent;

  const messages = [{ role: 'system', content: RESTAURANT_CONTEXT + '\n\n' + customerInfo }];
  for (let i = 0; i < (history || []).length; i++) messages.push(history[i]);
  messages.push({ role: 'user', content: text });

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + GROQ_API_KEY,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: messages,
        max_tokens: 300,
        temperature: 0.7
      })
    });
    if (!response.ok) {
      console.error('[wa-bridge] Groq error', response.status, await response.text());
      return null;
    }
    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content.trim();
    }
    return null;
  } catch (err) {
    console.error('[wa-bridge] Groq failed:', err.message);
    return null;
  }
}

// ---- Main handler ----------------------------------------------------------
module.exports = async function handler(req, res) {
  // Health check
  if (req.method === 'GET') {
    const secretSet = !!(process.env.BRIDGE_SECRET);
    return res.status(200).json({
      ok: true,
      configured: !!GROQ_API_KEY,
      bridge_secret_set: secretSet,
      note: secretSet ? null : 'Using baked-in default BRIDGE_SECRET — override in Vercel for production.'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!authorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }

  // The customer's WhatsApp id — digits only.
  const fromRaw = typeof body.from === 'string' ? body.from.replace(/[^\d]/g, '').slice(0, 20) : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const name = typeof body.name === 'string' ? body.name.slice(0, 120) : undefined;

  if (!fromRaw) return res.status(400).json({ error: 'from required' });
  if (!text) return res.status(400).json({ error: 'text required' });
  if (text.length > 4000) return res.status(400).json({ error: 'text too long (max 4000 chars)' });

  const phone = normalizePhone(fromRaw);

  try {
    const customer = await upsertCustomer(phone, name);
    if (!customer || !customer.id) {
      return res.status(500).json({ error: 'failed to upsert customer' });
    }

    // Honor opt-out
    if (customer.opted_out) {
      return res.status(200).json({ ok: true, reply: null, status: 'opted_out' });
    }

    const intent = detectIntent(text);

    // Save the inbound message
    await saveMessage(customer.id, text, 'inbound', intent);

    // Honor manual-mode (staff replies via dashboard)
    if (customer.reply_mode !== 'bot') {
      return res.status(200).json({ ok: true, reply: null, status: 'manual_mode' });
    }

    // Generate the AI reply
    const history = await getHistory(customer.id, 10);
    let reply = await generateReply(text, history, customer, intent);

    // Fallback so the customer never gets total silence
    if (!reply) {
      reply = "Thanks for your message! A team member will get back to you shortly.";
    }

    // Save the outbound reply (bridge sends it to WhatsApp)
    await saveMessage(customer.id, reply, 'outbound', 'bot_reply');

    return res.status(200).json({
      ok: true,
      reply: reply,
      status: 'ok',
      intent: intent,
      customer_id: customer.id
    });
  } catch (err) {
    console.error('[wa-bridge] error:', err);
    return res.status(500).json({ error: 'internal error', detail: err.message });
  }
};
