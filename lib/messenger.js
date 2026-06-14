// Shared helpers for the Meta Messenger Platform (Facebook Messenger + Instagram DMs).
// Both products use the same webhook payload shape and the same Send API
// (POST graph.facebook.com/v22.0/me/messages). The only difference is the
// page access token and the `object` field on the webhook payload.
//
// This module is used by /api/facebook-webhook.js and /api/instagram-webhook.js.
// It mirrors the patterns in /api/webhook.js (WhatsApp):
//   - Raw-body signature verification (fails closed if META_APP_SECRET missing)
//   - Atomic idempotency claim on conversations.wa_message_id
//   - Customer upsert keyed on (platform, platform_user_id)
//   - AI reply via OpenAI (same RESTAURANT_CONTEXT, intent detection)
//   - Send via Meta Graph API /me/messages
//
// NOTE: We reuse the existing `wa_message_id` column to store the FB/IG
// message id (`mid`). Migration 006 created a unique partial index on that
// column, so cross-platform mid collisions are extremely unlikely and the
// claim still works as an atomic dedupe key.

const crypto = require('crypto');
const { supabaseRequest } = require('./supabase');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ---- Restaurant knowledge base (shared with webhook.js) ------------------
const RESTAURANT_CONTEXT = [
  'You are the friendly assistant for Tilapiya — a popular Sri Lankan restaurant.',
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
  '- At the END of your reply, add a language tag on a new line: [lang:si] / [lang:ta] / [lang:en]',
  '',
  'BEHAVIOR RULES:',
  '- Be warm, friendly, and concise — keep messages short (3-4 sentences max)',
  '- For complaints, be empathetic and say a manager will reach out personally',
  '- Never make up prices, hours, or menu items',
  '- If someone wants to book, collect: date, time, party size, and any special occasion',
  '- Use emojis sparingly but warmly'
].join('\n');

// ---- Raw body reader -----------------------------------------------------
async function readRawBody(req) {
  var chunks = [];
  for await (var chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// ---- Webhook signature verification (raw bytes, fail closed) -------------
// `appSecret` is the App Secret of the Meta app that owns this webhook.
// FB and IG can be a different Meta app than WhatsApp, so each webhook passes
// its own secret in.
function verifyWebhookSignature(req, rawBody, appSecret) {
  if (!appSecret) {
    console.error('App secret not set - rejecting webhook (fail closed)');
    return false;
  }
  var signature = req.headers['x-hub-signature-256'];
  if (!signature || typeof signature !== 'string') return false;
  var expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (signature.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) { return false; }
}

// ---- Customer upsert by (platform, platform_user_id) ---------------------
// Strategy: customers.phone is UNIQUE NOT NULL in the schema, so for
// channels without a phone number we use a synthetic key derived from the
// platform — 'ig:<igsid>' / 'fb:<psid>'. This lets us reuse the existing
// on_conflict=phone upsert path that already works for WhatsApp.
function syntheticPhone(platform, platformUserId) {
  var prefix = platform === 'instagram' ? 'ig' : platform === 'facebook' ? 'fb' : platform;
  return prefix + ':' + platformUserId;
}

async function upsertMessengerCustomer(platform, platformUserId, displayName) {
  var synth = syntheticPhone(platform, platformUserId);

  // Fast-path lookup by (platform, platform_user_id)
  var existing = await supabaseRequest(
    'customers?platform=eq.' + encodeURIComponent(platform) +
    '&platform_user_id=eq.' + encodeURIComponent(platformUserId) +
    '&select=id,name,phone,segment,visit_count,reply_mode,opted_out,platform,platform_user_id&limit=1',
    'GET'
  );
  if (existing && existing.length > 0) {
    await supabaseRequest('customers?id=eq.' + existing[0].id, 'PATCH', {
      last_contact: new Date().toISOString(),
      name: displayName || existing[0].name
    });
    return existing[0];
  }

  // Race-safe create via on_conflict=phone (synthetic phone is unique per user).
  var created = await supabaseRequest(
    'customers?on_conflict=phone',
    'POST',
    {
      phone: synth,
      platform: platform,
      platform_user_id: platformUserId,
      name: displayName || (platform + ':' + platformUserId),
      segment: 'new',
      reply_mode: 'bot',
      last_contact: new Date().toISOString()
    },
    { 'Prefer': 'resolution=merge-duplicates,return=representation' }
  );
  return created && created[0] ? created[0] : null;
}

// ---- Idempotency: claim a stub row before any AI/media work --------------
async function claimInboundMessage(messageId, customerId, platform) {
  return supabaseRequest('conversations?on_conflict=wa_message_id', 'POST', {
    wa_message_id: messageId,
    customer_id: customerId,
    direction: 'inbound',
    message: '[processing]',
    intent: 'general',
    platform: platform,
    timestamp: new Date().toISOString()
  }, { 'Prefer': 'resolution=ignore-duplicates,return=representation' });
}

async function isMessageProcessed(messageId) {
  if (!messageId) return false;
  var existing = await supabaseRequest(
    'conversations?wa_message_id=eq.' + encodeURIComponent(messageId) + '&select=id&limit=1', 'GET'
  );
  return existing && existing.length > 0;
}

// ---- Finalize the claimed stub with the real message ---------------------
async function finalizeInboundMessage(stub, customerId, message, intent, messageId, detectedLanguage, platform) {
  if (stub && stub.id) {
    var updates = { message: message, intent: intent || 'general' };
    if (detectedLanguage) updates.detected_language = detectedLanguage;
    return supabaseRequest('conversations?id=eq.' + encodeURIComponent(stub.id), 'PATCH', updates);
  }
  // Fallback if claim didn't happen (no messageId)
  var record = {
    customer_id: customerId,
    direction: 'inbound',
    message: message,
    intent: intent || 'general',
    platform: platform,
    timestamp: new Date().toISOString()
  };
  if (messageId) record.wa_message_id = messageId;
  if (detectedLanguage) record.detected_language = detectedLanguage;
  return supabaseRequest('conversations', 'POST', record);
}

async function saveOutboundMessage(customerId, message, intent, messageId, detectedLanguage, deliveryStatus, platform) {
  var record = {
    customer_id: customerId,
    direction: 'outbound',
    message: message,
    intent: intent || 'general',
    platform: platform,
    timestamp: new Date().toISOString()
  };
  if (messageId) record.wa_message_id = messageId;
  if (detectedLanguage) record.detected_language = detectedLanguage;
  if (deliveryStatus) record.delivery_status = deliveryStatus;
  return supabaseRequest('conversations', 'POST', record);
}

// ---- Conversation history for the AI ------------------------------------
async function getConversationHistory(customerId, limit) {
  limit = limit || 10;
  var rows = await supabaseRequest(
    'conversations?customer_id=eq.' + encodeURIComponent(customerId) +
    '&select=direction,message,timestamp&order=timestamp.desc&limit=' + limit, 'GET'
  );
  if (!rows || rows.length === 0) return [];
  return rows.reverse().map(function (r) {
    return { role: r.direction === 'inbound' ? 'user' : 'assistant', content: r.message };
  });
}

// ---- Intent detection (mirrors webhook.js) ------------------------------
function detectIntent(text) {
  var lower = (text || '').toLowerCase();
  if (/menu|food|dish|eat|price|cost|how much/.test(lower)) return 'MENU';
  if (/book|reserv|table|party|event|private|karaoke/.test(lower)) return 'BOOKING';
  if (/where|location|address|direction|map/.test(lower)) return 'LOCATION';
  if (/complain|bad|terrible|worst|disappoint|angry|upset|rude|poor|refund/.test(lower)) return 'COMPLAINT';
  if (/thank|thanks|cheers|appreciate/.test(lower)) return 'THANKS';
  if (/^(hi|hello|hey|howdy|good morning|good evening|good afternoon)/.test(lower)) return 'GREETING';
  return 'GENERAL';
}

// ---- Language extraction from AI reply ----------------------------------
function extractLanguageFromReply(reply) {
  if (!reply) return { text: reply, language: null };
  var langMatch = reply.match(/\[lang:(si|ta|en)\]\s*$/);
  if (langMatch) {
    return {
      text: reply.replace(/\s*\[lang:(si|ta|en)\]\s*$/, '').trim(),
      language: langMatch[1]
    };
  }
  return { text: reply, language: null };
}

// ---- AI reply generation (OpenAI gpt-4o) --------------------------------
async function generateAIReply(customerMessage, history, customer, intent, platform) {
  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set, skipping bot reply');
    return null;
  }

  var customerInfo = 'Customer: ' + (customer.name || 'Unknown');
  customerInfo += ' | Visits: ' + (customer.visit_count || 0);
  customerInfo += ' | Segment: ' + (customer.segment || 'new');
  customerInfo += ' | Channel: ' + platform;
  customerInfo += ' | Detected intent: ' + intent;

  var messages = [{ role: 'system', content: RESTAURANT_CONTEXT + '\n\n' + customerInfo }];
  if (history && history.length > 0) {
    for (var i = 0; i < history.length; i++) messages.push(history[i]);
  }
  messages.push({ role: 'user', content: customerMessage });

  try {
    var response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messages,
        max_tokens: 300,
        temperature: 0.7
      })
    });
    if (!response.ok) {
      console.error('OpenAI error:', response.status, await response.text());
      return null;
    }
    var data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content.trim();
    }
    return null;
  } catch (err) {
    console.error('OpenAI request failed:', err.message);
    return null;
  }
}

// ---- Send via Meta Send API (used for FB Messenger & Instagram) ---------
// For both products: POST graph.facebook.com/v22.0/me/messages?access_token=<PAGE_TOKEN>
// Body: { recipient: { id: PSID }, message: { text }, messaging_type: 'RESPONSE' }
async function sendMessengerMessage(pageToken, recipientId, message) {
  if (!pageToken) {
    console.error('Page token not configured');
    return null;
  }
  try {
    var url = 'https://graph.facebook.com/v22.0/me/messages?access_token=' + encodeURIComponent(pageToken);
    var response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: message },
        messaging_type: 'RESPONSE'
      })
    });
    var data = await response.json();
    if (!response.ok) {
      console.error('Messenger send error:', response.status, data);
      return null;
    }
    return data.message_id || (data.messages && data.messages[0] && data.messages[0].id) || null;
  } catch (err) {
    console.error('Messenger send failed:', err.message);
    return null;
  }
}

// ---- Fetch user profile (name) from Graph API ---------------------------
// Best-effort; if it fails we fall back to using the PSID as the name.
async function fetchUserProfile(pageToken, userId) {
  if (!pageToken || !userId) return null;
  try {
    var url = 'https://graph.facebook.com/v22.0/' + encodeURIComponent(userId) +
      '?fields=name,first_name,last_name,username' +
      '&access_token=' + encodeURIComponent(pageToken);
    var r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    var d = await r.json();
    return d.name || (d.first_name ? (d.first_name + ' ' + (d.last_name || '')).trim() : d.username || null);
  } catch (e) {
    return null;
  }
}

// ---- Core inbound-message handler (shared by FB and IG webhooks) --------
// `platform` is 'facebook' or 'instagram'; `pageToken` is the matching token.
// `pageIds` is an optional array of the page/IG-account ids we own; messages
// sent BY the page (echo) are ignored.
async function processMessagingEntry(messagingEvent, opts) {
  var platform = opts.platform;
  var pageToken = opts.pageToken;
  var pageIds = opts.pageIds || [];

  if (!messagingEvent || !messagingEvent.message) return;

  var msg = messagingEvent.message;
  var senderId = messagingEvent.sender && messagingEvent.sender.id;
  var recipientId = messagingEvent.recipient && messagingEvent.recipient.id;
  var messageId = msg.mid || null;

  if (!senderId) return;
  // Ignore echoes of our own page messages
  if (msg.is_echo) return;
  if (pageIds.length && pageIds.indexOf(senderId) !== -1) return;

  // Fast-path dedupe
  if (messageId && await isMessageProcessed(messageId)) {
    console.log('Duplicate ' + platform + ' message skipped (fast):', messageId);
    return;
  }

  // Look up / create customer
  var displayName = await fetchUserProfile(pageToken, senderId);
  var customer = await upsertMessengerCustomer(platform, senderId, displayName);
  if (!customer || !customer.id) {
    console.error('Failed to upsert ' + platform + ' customer for', senderId);
    return;
  }
  var customerId = customer.id;

  // Atomic claim BEFORE any AI work
  var stub = null;
  if (messageId) {
    var claimed = await claimInboundMessage(messageId, customerId, platform);
    if (!claimed || !claimed[0]) {
      console.log('Duplicate ' + platform + ' message skipped (claim):', messageId);
      return;
    }
    stub = claimed[0];
  }

  // Extract text (or summarize attachments)
  var text;
  var messageType = 'text';
  if (typeof msg.text === 'string' && msg.text.length) {
    text = msg.text;
  } else if (Array.isArray(msg.attachments) && msg.attachments.length) {
    var att = msg.attachments[0];
    messageType = att.type || 'attachment';
    text = '[' + (att.type || 'attachment') + ' received]';
  } else {
    text = '[Unsupported ' + platform + ' message]';
  }

  var intent = detectIntent(text);
  await finalizeInboundMessage(stub, customerId, text, intent, messageId, null, platform);
  console.log(platform + ' message saved:', senderId, intent, text.slice(0, 80));

  // AI reply
  var shouldReply = (
    customer.reply_mode === 'bot' &&
    !customer.opted_out &&
    messageType === 'text' &&
    OPENAI_API_KEY &&
    pageToken
  );

  if (!shouldReply) {
    console.log('Bot reply skipped (' + platform + '):', senderId,
      'reply_mode=' + (customer.reply_mode || 'unknown'),
      'opted_out=' + !!customer.opted_out,
      'type=' + messageType
    );
    return;
  }

  try {
    var history = await getConversationHistory(customerId, 10);
    var aiReply = await generateAIReply(text, history, customer, intent, platform);
    if (!aiReply) {
      console.log('No AI reply generated (' + platform + ') for:', senderId);
      return;
    }
    var parsed = extractLanguageFromReply(aiReply);
    var cleanReply = parsed.text;
    var replyLanguage = parsed.language;

    var replyMsgId = await sendMessengerMessage(pageToken, senderId, cleanReply);
    if (replyMsgId) {
      await saveOutboundMessage(customerId, cleanReply, 'bot_reply', replyMsgId, replyLanguage, 'sent', platform);
      console.log(platform + ' bot replied to:', senderId, '(lang:' + (replyLanguage || '?') + ')');
    } else {
      await saveOutboundMessage(customerId, cleanReply, 'bot_reply', null, replyLanguage, 'failed', platform);
      console.error(platform + ' bot reply send FAILED for:', senderId);
    }
  } catch (botErr) {
    console.error('Bot reply error (' + platform + ', non-fatal):', botErr.message);
  }
}

// ---- Entry point used by both webhook endpoints -------------------------
// expectedObject: 'page' for FB, 'instagram' for IG.
async function handleMessengerPost(body, opts) {
  if (!body || !body.entry) return;
  // Meta sends "object" once at the top level. For Messenger it's "page",
  // for Instagram it's "instagram". We allow either if `expectedObject` is
  // not set, so a unified endpoint would still work.
  if (opts.expectedObject && body.object && body.object !== opts.expectedObject) {
    console.log('Skipping webhook payload with object=' + body.object);
    return;
  }

  for (var e = 0; e < body.entry.length; e++) {
    var entry = body.entry[e];
    var events = entry.messaging || [];
    for (var i = 0; i < events.length; i++) {
      try {
        await processMessagingEntry(events[i], opts);
      } catch (err) {
        console.error(opts.platform + ' entry error:', err.message);
      }
    }
  }
}

module.exports = {
  readRawBody,
  verifyWebhookSignature,
  handleMessengerPost,
  // Re-exports used by the send.js multi-channel router
  sendMessengerMessage,
  fetchUserProfile
};
