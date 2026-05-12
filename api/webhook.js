// Vercel Serverless Function - WhatsApp Webhook for Tilapiya CRM
// Receives WhatsApp messages from Meta and stores them in Supabase

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'tilapiya_verify_2026';
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

async function upsertCustomer(phone, name) {
  const existing = await supabaseRequest(
    'customers?phone=eq.' + encodeURIComponent(phone) + '&select=id,phone,name', 'GET'
  );
  if (existing && existing.length > 0) {
    await supabaseRequest('customers?id=eq.' + existing[0].id, 'PATCH',
      { last_contact: new Date().toISOString(), name: name || existing[0].name });
    return existing[0].id;
  }
  const created = await supabaseRequest('customers', 'POST', {
    phone, name: name || phone, segment: 'new'
  });
  return created && created[0] ? created[0].id : null;
}

async function saveMessage(customerId, message, direction) {
  return supabaseRequest('conversations', 'POST', {
    customer_id: customerId, direction, message,
    intent: 'pending', timestamp: new Date().toISOString()
  });
}

async function sendWhatsAppReply(to, text) {
  if (!WA_TOKEN || !WA_PHONE_ID) return;
  try {
    await fetch('https://graph.facebook.com/v21.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'text',
        text: { body: text }
      })
    });
  } catch (e) { console.error('WhatsApp reply error:', e); }
}

module.exports = async function handler(req, res) {
  // GET = Meta webhook verification
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }
  // POST = incoming WhatsApp message
  if (req.method === 'POST') {
    try {
      const body = req.body;
      if (!body || !body.entry) return res.status(200).json({ status: 'no entry' });
      for (const entry of body.entry) {
        const changes = entry.changes || [];
        for (const change of changes) {
          if (change.field !== 'messages') continue;
          const value = change.value || {};
          const messages = value.messages || [];
          const contacts = value.contacts || [];
          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const contact = contacts[i] || {};
            const phone = msg.from;
            const name = contact.profile ? contact.profile.name : null;
            const text = msg.text ? msg.text.body : '[media]';
            const customerId = await upsertCustomer(phone, name);
            if (customerId) {
              await saveMessage(customerId, text, 'inbound');
              await sendWhatsAppReply(phone,
                'Thank you for your message! Our team will get back to you shortly.');
              await saveMessage(customerId,
                'Thank you for your message! Our team will get back to you shortly.', 'outbound');
            }
          }
        }
      }
      return res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error('Webhook error:', err);
      return res.status(200).json({ status: 'error', message: err.message });
    }
  }
  return res.status(405).send('Method not allowed');
};
