// Vercel Serverless Function - WhatsApp Webhook for Tilapiya CRM
// AI CHATBOT: Saves inbound messages + auto-replies using OpenAI GPT-4o
// Supports: Text, Image (GPT-4o Vision), Voice (Whisper), Documents, Video
// Multi-language: Detects and responds in Sinhala, Tamil, or English
// Respects per-customer reply_mode ('bot' = auto-reply, 'manual' = no bot)
// SECURITY: Verifies Meta webhook signature on the RAW request body and
// FAILS CLOSED if META_APP_SECRET is not configured.
// IDEMPOTENCY: Claims each wa_message_id via a unique-index upsert before
// any AI/media processing, so Meta retries never double-process.

const crypto = require('crypto');
const { normalizePhone } = require('../lib/phone');
const { supabaseRequest } = require('../lib/supabase');

const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// NOTE: Vercel's body parser is disabled via module.exports.config at the
// bottom of this file so the signature can be verified on raw bytes.

// --- RESTAURANT KNOWLEDGE BASE ---
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
  '- At the END of your reply, add a language tag on a new line: [lang:si] for Sinhala, [lang:ta] for Tamil, [lang:en] for English',
  '',
  'BEHAVIOR RULES:',
  '- Be warm, friendly, and concise — this is WhatsApp, keep messages short',
  '- Use a casual but professional tone',
  '- If you do not know something specific (like exact prices), say you will check and a team member will follow up',
  '- For complaints, be empathetic, apologize, and say a manager will reach out personally',
  '- Never make up prices, hours, or menu items you are not sure about',
  '- If someone wants to make a booking, collect: date, time, party size, and any special occasion',
  '- Use emojis sparingly but warmly',
  '- Maximum response length: 3-4 short sentences for simple queries',
  '',
  'MEDIA HANDLING:',
  '- When an image description is provided, use it to understand what the customer sent',
  '- If it looks like a menu photo, help identify items or answer questions about them',
  '- If it looks like a receipt, acknowledge it and offer help',
  '- If it is a food photo, compliment it or help identify the dish',
  '- When a voice transcription is provided, treat it as the customer message',
  '- For documents, acknowledge receipt and ask how you can help'
].join('\n');

// --- RAW BODY READER ---
async function readRawBody(req) {
  var chunks = [];
  for await (var chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// --- WEBHOOK SIGNATURE VERIFICATION (raw bytes, fail closed) ---
function verifyWebhookSignature(req, rawBody) {
  if (!META_APP_SECRET) {
    console.error('META_APP_SECRET not set - rejecting webhook (fail closed)');
    return false;
  }
  var signature = req.headers['x-hub-signature-256'];
  if (!signature || typeof signature !== 'string') return false;
  var expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(rawBody).digest('hex');
  if (signature.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) { return false; }
}

// --- DEDUPLICATION (fast path) ---
async function isMessageProcessed(waMessageId) {
  if (!waMessageId) return false;
  var existing = await supabaseRequest(
    'conversations?wa_message_id=eq.' + encodeURIComponent(waMessageId) + '&select=id&limit=1', 'GET'
  );
  return existing && existing.length > 0;
}

// --- IDEMPOTENCY CLAIM ---
// Inserts a stub conversations row keyed on wa_message_id. The partial unique
// index (migration 006) + ignore-duplicates makes this an atomic claim:
// returns the stub row when claimed, [] when a duplicate, null on error.
async function claimInboundMessage(waMessageId, customerId) {
  return supabaseRequest('conversations?on_conflict=wa_message_id', 'POST', {
    wa_message_id: waMessageId,
    customer_id: customerId,
    direction: 'inbound',
    message: '[processing]',
    intent: 'general',
    timestamp: new Date().toISOString()
  }, { 'Prefer': 'resolution=ignore-duplicates,return=representation' });
}

// --- CUSTOMER MANAGEMENT ---
async function upsertCustomer(phone, name) {
  var existing = await supabaseRequest(
    'customers?phone=eq.' + encodeURIComponent(phone) + '&select=id,phone,name,segment,visit_count,reply_mode,opted_out', 'GET'
  );
  if (existing && existing.length > 0) {
    await supabaseRequest('customers?id=eq.' + existing[0].id, 'PATCH',
      { last_contact: new Date().toISOString(), name: name || existing[0].name });
    return existing[0];
  }
  // Race-safe create: unique(phone) + merge-duplicates upsert.
  var created = await supabaseRequest('customers?on_conflict=phone', 'POST', {
    phone: phone, name: name || phone, segment: 'new', reply_mode: 'bot',
    last_contact: new Date().toISOString()
  }, { 'Prefer': 'resolution=merge-duplicates,return=representation' });
  return created && created[0] ? created[0] : null;
}

// --- MESSAGE STORAGE (with language detection support) ---
async function saveMessage(customerId, message, direction, intent, waMessageId, detectedLanguage, deliveryStatus) {
  var record = {
    customer_id: customerId, direction: direction, message: message,
    intent: intent || 'general', timestamp: new Date().toISOString()
  };
  if (waMessageId) record.wa_message_id = waMessageId;
  if (detectedLanguage) record.detected_language = detectedLanguage;
  if (deliveryStatus) record.delivery_status = deliveryStatus;
  return supabaseRequest('conversations', 'POST', record);
}

// --- FINALIZE A CLAIMED STUB (or insert if no stub exists) ---
async function finalizeInboundMessage(stub, customerId, message, intent, waMessageId, detectedLanguage) {
  if (stub && stub.id) {
    var updates = { message: message, intent: intent || 'general' };
    if (detectedLanguage) updates.detected_language = detectedLanguage;
    return supabaseRequest('conversations?id=eq.' + encodeURIComponent(stub.id), 'PATCH', updates);
  }
  return saveMessage(customerId, message, 'inbound', intent, waMessageId, detectedLanguage);
}

// --- MEDIA MESSAGE STORAGE ---
// Columns match media_messages schema (005) + additions from migration 006
// (wa_message_id, file_size, original_filename, processed_at).
async function saveMediaMessage(customerId, waMessageId, mediaType, mediaId, metadata) {
  var record = {
    customer_id: customerId,
    wa_message_id: waMessageId || null,
    media_type: mediaType,
    wa_media_id: mediaId || null,
    mime_type: (metadata && metadata.mimeType) || null,
    description: (metadata && metadata.description) || null,
    transcription: (metadata && metadata.transcription) || null,
    file_size: (metadata && metadata.fileSize) || null,
    original_filename: (metadata && metadata.filename) || null,
    processed_at: new Date().toISOString()
  };
  return supabaseRequest('media_messages', 'POST', record);
}

// --- FETCH CONVERSATION HISTORY ---
async function getConversationHistory(customerId, limit) {
  limit = limit || 10;
  var rows = await supabaseRequest(
    'conversations?customer_id=eq.' + encodeURIComponent(customerId) +
    '&select=direction,message,timestamp&order=timestamp.desc&limit=' + limit, 'GET'
  );
  if (!rows || rows.length === 0) return [];
  return rows.reverse().map(function(r) {
    return { role: r.direction === 'inbound' ? 'user' : 'assistant', content: r.message };
  });
}

// --- FETCH CUSTOMER BOOKINGS ---
async function getCustomerBookings(customerId) {
  var rows = await supabaseRequest(
    'bookings?customer_id=eq.' + encodeURIComponent(customerId) +
    '&select=date,time,party_size,occasion,status&order=date.desc&limit=3', 'GET'
  );
  return rows || [];
}

// --- SIMPLE INTENT DETECTION ---
function detectIntent(text) {
  var lower = text.toLowerCase();
  if (/menu|food|dish|eat|price|cost|how much/.test(lower)) return 'MENU';
  if (/book|reserv|table|party|event|private|karaoke/.test(lower)) return 'BOOKING';
  if (/where|location|address|direction|map/.test(lower)) return 'LOCATION';
  if (/complain|bad|terrible|worst|disappoint|angry|upset|rude|poor|refund/.test(lower)) return 'COMPLAINT';
  if (/thank|thanks|cheers|appreciate/.test(lower)) return 'THANKS';
  if (/^(hi|hello|hey|howdy|good morning|good evening|good afternoon)/.test(lower)) return 'GREETING';
  return 'GENERAL';
}

// --- OPT-OUT / OPT-IN KEYWORDS ---
var STOP_KEYWORDS = ['stop', 'unsubscribe', 'opt out', 'නවත්වන්න', 'நிறுத்து'];
var START_KEYWORDS = ['start'];

// ============================================================
// WHATSAPP MEDIA DOWNLOAD
// ============================================================
async function downloadWhatsAppMedia(mediaId) {
  if (!WA_TOKEN || !mediaId) return null;

  try {
    // Step 1: Get the media URL
    var metaRes = await fetch('https://graph.facebook.com/v22.0/' + mediaId, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN },
      signal: AbortSignal.timeout(15000)
    });

    if (!metaRes.ok) {
      console.error('Media metadata fetch failed:', metaRes.status, await metaRes.text());
      return null;
    }

    var metaData = await metaRes.json();
    var mediaUrl = metaData.url;
    var mimeType = metaData.mime_type || 'application/octet-stream';

    if (!mediaUrl) {
      console.error('No media URL returned for media_id:', mediaId);
      return null;
    }

    // Step 2: Download the binary content
    var mediaRes = await fetch(mediaUrl, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN },
      signal: AbortSignal.timeout(20000)
    });

    if (!mediaRes.ok) {
      console.error('Media download failed:', mediaRes.status);
      return null;
    }

    var buffer = Buffer.from(await mediaRes.arrayBuffer());
    return { buffer: buffer, mimeType: mimeType, fileSize: buffer.length };
  } catch (err) {
    console.error('Media download error:', err.message);
    return null;
  }
}

// ============================================================
// IMAGE PROCESSING - GPT-4o Vision
// ============================================================
async function describeImageWithVision(imageBuffer, mimeType, caption) {
  if (!OPENAI_API_KEY || !imageBuffer) return null;

  try {
    var base64Image = imageBuffer.toString('base64');
    var dataUri = 'data:' + (mimeType || 'image/jpeg') + ';base64,' + base64Image;

    var userContent = [
      {
        type: 'text',
        text: 'Describe this image sent by a restaurant customer on WhatsApp. '
          + 'If it contains text (menu, receipt, sign, etc.), extract/OCR all readable text. '
          + 'If it is a food photo, identify the dish(es). '
          + 'Be concise (2-3 sentences max). '
          + (caption ? 'The customer also wrote: "' + caption + '"' : '')
      },
      {
        type: 'image_url',
        image_url: { url: dataUri, detail: 'low' }
      }
    ];

    var response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(25000),
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'user', content: userContent }
        ],
        max_tokens: 300,
        temperature: 0.3
      })
    });

    if (!response.ok) {
      console.error('Vision API error:', response.status, await response.text());
      return null;
    }

    var data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content.trim();
    }
    return null;
  } catch (err) {
    console.error('Vision processing error:', err.message);
    return null;
  }
}

// ============================================================
// VOICE/AUDIO TRANSCRIPTION - OpenAI Whisper
// ============================================================
async function transcribeAudioWithWhisper(audioBuffer, mimeType) {
  if (!OPENAI_API_KEY || !audioBuffer) return null;

  try {
    var extMap = {
      'audio/ogg': 'ogg',
      'audio/ogg; codecs=opus': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/wav': 'wav',
      'audio/webm': 'webm',
      'audio/amr': 'amr'
    };
    var cleanMime = (mimeType || 'audio/ogg').split(';')[0].trim();
    var ext = extMap[cleanMime] || extMap[mimeType] || 'ogg';
    var filename = 'audio.' + ext;

    // Build multipart/form-data manually
    var boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex');
    var CRLF = '\r\n';

    var filePart = '--' + boundary + CRLF
      + 'Content-Disposition: form-data; name="file"; filename="' + filename + '"' + CRLF
      + 'Content-Type: ' + (cleanMime || 'audio/ogg') + CRLF
      + CRLF;

    var modelPart = CRLF + '--' + boundary + CRLF
      + 'Content-Disposition: form-data; name="model"' + CRLF
      + CRLF
      + 'whisper-1' + CRLF;

    var closingBoundary = '--' + boundary + '--' + CRLF;

    var bodyBuffer = Buffer.concat([
      Buffer.from(filePart, 'utf-8'),
      audioBuffer,
      Buffer.from(modelPart, 'utf-8'),
      Buffer.from(closingBoundary, 'utf-8')
    ]);

    var response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'multipart/form-data; boundary=' + boundary
      },
      signal: AbortSignal.timeout(30000),
      body: bodyBuffer
    });

    if (!response.ok) {
      console.error('Whisper API error:', response.status, await response.text());
      return null;
    }

    var data = await response.json();
    return data.text ? data.text.trim() : null;
  } catch (err) {
    console.error('Whisper transcription error:', err.message);
    return null;
  }
}

// ============================================================
// LANGUAGE EXTRACTION FROM AI REPLY
// ============================================================
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

// --- GENERATE AI REPLY (enhanced with language & media context) ---
async function generateAIReply(customerMessage, conversationHistory, customer, intent, bookings, mediaContext) {
  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set, skipping bot reply');
    return null;
  }

  var customerInfo = 'Customer: ' + (customer.name || 'Unknown');
  customerInfo += ' | Visits: ' + (customer.visit_count || 0);
  customerInfo += ' | Segment: ' + (customer.segment || 'new');
  customerInfo += ' | Detected intent: ' + intent;

  if (bookings && bookings.length > 0) {
    customerInfo += '\nRecent bookings: ' + bookings.map(function(b) {
      return b.date + ' ' + (b.time || '') + ' (' + b.status + ', party of ' + (b.party_size || '?') + ')';
    }).join('; ');
  }

  if (mediaContext) {
    customerInfo += '\n\nMEDIA CONTEXT: ' + mediaContext;
  }

  var messages = [
    { role: 'system', content: RESTAURANT_CONTEXT + '\n\n' + customerInfo }
  ];

  if (conversationHistory && conversationHistory.length > 0) {
    for (var i = 0; i < conversationHistory.length; i++) {
      messages.push(conversationHistory[i]);
    }
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
        model: 'gpt-4o',
        messages: messages,
        max_tokens: 300,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      var errText = await response.text();
      console.error('OpenAI API error:', response.status, errText);
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

// --- SEND WHATSAPP REPLY ---
async function sendWhatsAppMessage(to, message) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.error('WhatsApp credentials not configured');
    return null;
  }

  try {
    var response = await fetch('https://graph.facebook.com/v22.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + WA_TOKEN,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      })
    });

    var data = await response.json();
    if (!response.ok) {
      console.error('WhatsApp send error:', data);
      return null;
    }
    return data.messages && data.messages[0] ? data.messages[0].id : null;
  } catch (err) {
    console.error('WhatsApp send failed:', err.message);
    return null;
  }
}

// --- HANDLE READ RECEIPTS & DELIVERY STATUS ---
// Updates both conversations.delivery_status and outbox_messages
// (status + delivered_at/read_at) for the given wa_message_id.
async function handleStatusUpdate(status) {
  var waMessageId = status.id;
  var statusType = status.status;
  if (!waMessageId || !statusType) return;
  if (statusType === 'delivered' || statusType === 'read') {
    await supabaseRequest(
      'conversations?wa_message_id=eq.' + encodeURIComponent(waMessageId),
      'PATCH',
      { delivery_status: statusType }
    );
    var outboxUpdate = { status: statusType };
    if (statusType === 'delivered') outboxUpdate.delivered_at = new Date().toISOString();
    if (statusType === 'read') outboxUpdate.read_at = new Date().toISOString();
    await supabaseRequest(
      'outbox_messages?wa_message_id=eq.' + encodeURIComponent(waMessageId),
      'PATCH',
      outboxUpdate
    );
  }
}

// ============================================================
// PROCESS MEDIA MESSAGE
// ============================================================
async function processMediaMessage(msg, messageType, customerId, waMessageId) {
  var result = { text: null, mediaContext: null, detectedLanguage: null };

  // --- IMAGE PROCESSING ---
  if (messageType === 'image' && msg.image) {
    var imageId = msg.image.id;
    var caption = msg.image.caption || '';
    result.text = '[Image received]' + (caption ? ': ' + caption : '');

    var mediaData = await downloadWhatsAppMedia(imageId);
    if (mediaData) {
      var description = await describeImageWithVision(mediaData.buffer, mediaData.mimeType, caption);
      if (description) {
        result.mediaContext = 'Customer sent an image. AI description: ' + description;
        result.text = '[Image: ' + description + ']' + (caption ? ' Caption: ' + caption : '');
      }

      await saveMediaMessage(customerId, waMessageId, 'image', imageId, {
        mimeType: mediaData.mimeType,
        fileSize: mediaData.fileSize,
        description: description || 'Image could not be analyzed',
        filename: msg.image.filename || null
      });
    } else {
      result.mediaContext = 'Customer sent an image but it could not be downloaded.';
      await saveMediaMessage(customerId, waMessageId, 'image', imageId, {
        mimeType: msg.image.mime_type || null,
        description: 'Download failed'
      });
    }

    return result;
  }

  // --- VOICE/AUDIO PROCESSING ---
  if (messageType === 'audio' && (msg.audio || msg.voice)) {
    var audioObj = msg.voice || msg.audio;
    var audioId = audioObj.id;
    result.text = '[Voice message received]';

    var audioData = await downloadWhatsAppMedia(audioId);
    if (audioData) {
      var transcription = await transcribeAudioWithWhisper(audioData.buffer, audioData.mimeType);
      if (transcription) {
        result.text = transcription;
        result.mediaContext = 'Customer sent a voice message. Transcription: ' + transcription;
      } else {
        result.mediaContext = 'Customer sent a voice message but transcription failed.';
      }

      await saveMediaMessage(customerId, waMessageId, 'audio', audioId, {
        mimeType: audioData.mimeType,
        fileSize: audioData.fileSize,
        transcription: transcription || 'Transcription failed'
      });
    } else {
      result.mediaContext = 'Customer sent a voice message but it could not be downloaded.';
      await saveMediaMessage(customerId, waMessageId, 'audio', audioId, {
        mimeType: audioObj.mime_type || null,
        transcription: 'Download failed'
      });
    }

    return result;
  }

  // --- DOCUMENT HANDLING ---
  if (messageType === 'document' && msg.document) {
    var docFilename = msg.document.filename || 'unknown';
    var docMimeType = msg.document.mime_type || 'application/octet-stream';
    result.text = '[Document received: ' + docFilename + ']';
    result.mediaContext = 'Customer sent a document: ' + docFilename + ' (type: ' + docMimeType + ')';

    await saveMediaMessage(customerId, waMessageId, 'document', msg.document.id, {
      filename: docFilename,
      mimeType: docMimeType,
      description: 'Document: ' + docFilename
    });

    return result;
  }

  // --- VIDEO HANDLING ---
  if (messageType === 'video' && msg.video) {
    var videoCaption = msg.video.caption || '';
    result.text = '[Video received]' + (videoCaption ? ': ' + videoCaption : '');
    result.mediaContext = 'Customer sent a video.' + (videoCaption ? ' Caption: ' + videoCaption : '');

    await saveMediaMessage(customerId, waMessageId, 'video', msg.video.id, {
      mimeType: msg.video.mime_type || null,
      description: 'Video' + (videoCaption ? ': ' + videoCaption : '')
    });

    return result;
  }

  return null; // Not a media message we handle
}

// --- OPT-OUT / OPT-IN HANDLER ---
// Returns true when the message was a STOP/START keyword (already handled).
async function handleOptKeywords(rawText, customer, phone, stub, waMessageId) {
  if (!rawText) return false;
  var normalized = rawText.trim().toLowerCase();

  if (STOP_KEYWORDS.indexOf(normalized) !== -1) {
    await supabaseRequest('customers?id=eq.' + encodeURIComponent(customer.id), 'PATCH', { opted_out: true });
    await finalizeInboundMessage(stub, customer.id, rawText, 'opt_out', waMessageId, null);
    var stopReply = "You've been unsubscribed. Reply START to resubscribe.";
    var stopWaId = await sendWhatsAppMessage(phone, stopReply);
    if (stopWaId) {
      await saveMessage(customer.id, stopReply, 'outbound', 'opt_out_confirm', stopWaId, null);
    } else {
      console.error('Opt-out confirmation send failed for', phone);
    }
    console.log('Customer opted out:', phone);
    return true;
  }

  if (START_KEYWORDS.indexOf(normalized) !== -1) {
    await supabaseRequest('customers?id=eq.' + encodeURIComponent(customer.id), 'PATCH', { opted_out: false });
    await finalizeInboundMessage(stub, customer.id, rawText, 'opt_in', waMessageId, null);
    var startReply = "You're resubscribed. Welcome back to Tilapiya updates!";
    var startWaId = await sendWhatsAppMessage(phone, startReply);
    if (startWaId) {
      await saveMessage(customer.id, startReply, 'outbound', 'opt_in_confirm', startWaId, null);
    } else {
      console.error('Opt-in confirmation send failed for', phone);
    }
    console.log('Customer opted back in:', phone);
    return true;
  }

  return false;
}

// --- MAIN HANDLER ---
module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    if (!VERIFY_TOKEN) {
      console.error('WEBHOOK_VERIFY_TOKEN not set');
      return res.status(500).send('Server misconfigured');
    }
    var mode = req.query['hub.mode'];
    var token = req.query['hub.verify_token'];
    var challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    var rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (readErr) {
      console.error('Failed to read raw body:', readErr.message);
      return res.status(400).json({ status: 'bad request' });
    }

    if (!verifyWebhookSignature(req, rawBody)) {
      console.error('Invalid webhook signature');
      return res.status(401).json({ status: 'invalid signature' });
    }

    try {
      var body;
      try {
        body = JSON.parse(rawBody.toString('utf-8'));
      } catch (parseErr) {
        console.error('Invalid JSON body:', parseErr.message);
        return res.status(400).json({ status: 'invalid json' });
      }
      if (!body || !body.entry) return res.status(200).json({ status: 'no entry' });

      for (var e = 0; e < body.entry.length; e++) {
        var entry = body.entry[e];
        var changes = entry.changes || [];
        for (var c = 0; c < changes.length; c++) {
          var change = changes[c];
          if (change.field !== 'messages') continue;
          var value = change.value || {};

          var statuses = value.statuses || [];
          for (var s = 0; s < statuses.length; s++) {
            await handleStatusUpdate(statuses[s]);
          }

          var messages = value.messages || [];
          var contacts = value.contacts || [];

          // Contacts are keyed by wa_id, NOT index-aligned with messages.
          var contactByWaId = {};
          for (var ci = 0; ci < contacts.length; ci++) {
            if (contacts[ci] && contacts[ci].wa_id) {
              contactByWaId[contacts[ci].wa_id] = contacts[ci];
            }
          }

          for (var i = 0; i < messages.length; i++) {
            var msg = messages[i];
            var contact = contactByWaId[msg.from] || {};
            var phone = normalizePhone(msg.from);
            var name = contact.profile ? contact.profile.name : null;
            var waMessageId = msg.id || null;

            // Fast-path dedupe (the claim below is the authoritative check)
            if (waMessageId && await isMessageProcessed(waMessageId)) {
              console.log('Duplicate message skipped (fast path):', waMessageId);
              continue;
            }

            // Upsert customer early so we have customerId for the claim
            var customer = await upsertCustomer(phone, name);
            if (!customer || !customer.id) {
              console.error('Failed to upsert customer for', phone, '- skipping message');
              continue;
            }
            var customerId = customer.id;

            // Atomic idempotency claim BEFORE any AI/media processing
            var stub = null;
            if (waMessageId) {
              var claimed = await claimInboundMessage(waMessageId, customerId);
              if (!claimed || !claimed[0]) {
                console.log('Duplicate message skipped (claim):', waMessageId);
                continue;
              }
              stub = claimed[0];
            }

            // --- STOP / START opt-out handling (skips AI entirely) ---
            var rawText = msg.text && msg.text.body ? msg.text.body : null;
            if (rawText && await handleOptKeywords(rawText, customer, phone, stub, waMessageId)) {
              continue;
            }

            var text;
            var messageType = msg.type || 'text';
            var mediaContext = null;
            var detectedLanguage = null;

            // --- PROCESS MEDIA TYPES ---
            if (messageType === 'image' || messageType === 'audio' ||
                messageType === 'document' || messageType === 'video' ||
                (messageType === 'voice') || (msg.voice)) {
              // Normalize voice type
              if (msg.voice) messageType = 'audio';

              var mediaResult = await processMediaMessage(msg, messageType, customerId, waMessageId);
              if (mediaResult) {
                text = mediaResult.text;
                mediaContext = mediaResult.mediaContext;
                detectedLanguage = mediaResult.detectedLanguage;
              } else {
                text = '[' + messageType + ' message received]';
              }
            }
            // --- TEXT MESSAGES ---
            else if (msg.text) {
              text = msg.text.body;
              messageType = 'text';
            }
            // --- OTHER TYPES (location, contacts, stickers, etc.) ---
            else if (msg.location) {
              text = '[Location shared: ' + (msg.location.name || msg.location.latitude + ',' + msg.location.longitude) + ']';
              messageType = 'location';
            } else if (msg.contacts) {
              text = '[Contact card shared]';
              messageType = 'contact';
            } else if (msg.sticker) {
              text = '[Sticker]';
              messageType = 'sticker';
            } else {
              text = '[Unsupported message type: ' + messageType + ']';
            }

            var intent = detectIntent(text);
            await finalizeInboundMessage(stub, customerId, text, intent, waMessageId, detectedLanguage);
            console.log('Message saved:', phone, intent, messageType, text.slice(0, 80));

            // --- AI CHATBOT REPLY ---
            var replyableTypes = ['text', 'image', 'audio', 'document', 'video'];
            var shouldReply = (
              customer.reply_mode === 'bot' &&
              !customer.opted_out &&
              replyableTypes.indexOf(messageType) !== -1 &&
              OPENAI_API_KEY &&
              WA_TOKEN &&
              WA_PHONE_ID
            );

            if (shouldReply) {
              try {
                var historyAndBookings = await Promise.all([
                  getConversationHistory(customerId, 10),
                  getCustomerBookings(customerId)
                ]);
                var history = historyAndBookings[0];
                var bookings = historyAndBookings[1];

                var aiReply = await generateAIReply(text, history, customer, intent, bookings, mediaContext);

                if (aiReply) {
                  var parsed = extractLanguageFromReply(aiReply);
                  var cleanReply = parsed.text;
                  var replyLanguage = parsed.language || detectedLanguage;

                  // Update the inbound message with detected language if we got it from the reply
                  if (replyLanguage && waMessageId) {
                    await supabaseRequest(
                      'conversations?wa_message_id=eq.' + encodeURIComponent(waMessageId),
                      'PATCH',
                      { detected_language: replyLanguage }
                    );
                  }

                  var replyWaId = await sendWhatsAppMessage(phone, cleanReply);
                  if (replyWaId) {
                    // Only record as sent when WhatsApp confirmed with a message id
                    await saveMessage(customerId, cleanReply, 'outbound', 'bot_reply', replyWaId, replyLanguage);
                    console.log('Bot replied to:', phone, '(lang:' + (replyLanguage || '?') + ')', cleanReply.slice(0, 60));
                  } else {
                    // Save with a failed marker so the dashboard can surface it
                    await saveMessage(customerId, cleanReply, 'outbound', 'bot_reply', null, replyLanguage, 'failed');
                    console.error('Bot reply send FAILED for:', phone);
                  }
                } else {
                  console.log('No AI reply generated for:', phone);
                }
              } catch (botErr) {
                console.error('Bot reply error (non-fatal):', botErr.message);
              }
            } else {
              console.log('Bot reply skipped:', phone,
                'reply_mode=' + (customer.reply_mode || 'unknown'),
                'opted_out=' + !!customer.opted_out,
                'type=' + messageType
              );
            }
          }
        }
      }
      return res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error('Webhook error:', err);
      return res.status(200).json({ status: 'error' });
    }
  }

  return res.status(405).send('Method not allowed');
};

// Re-attach config after handler assignment (module.exports was replaced above)
module.exports.config = { api: { bodyParser: false } };
