// Vercel Serverless Function - WhatsApp Webhook for Tilapiya CRM
// AI CHATBOT: Saves inbound messages + auto-replies using OpenAI GPT-4o
// Supports: Text, Image (GPT-4o Vision), Voice (Whisper), Documents, Video
// Multi-language: Detects and responds in Sinhala, Tamil, or English
// Respects per-customer reply_mode ('bot' = auto-reply, 'manual' = no bot)
// SECURITY: Verifies Meta webhook signature when META_APP_SECRET is set.

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

// --- WEBHOOK SIGNATURE VERIFICATION ---
function verifyWebhookSignature(req) {
  if (!META_APP_SECRET) return true;
  var signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  var rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  var expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(rawBody).digest('hex');
  if (signature.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) { return false; }
}

// --- SUPABASE HELPER ---
async function supabaseRequest(path, method, body) {
  var headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
  if (method === 'POST' || method === 'PATCH') headers['Prefer'] = 'return=representation';
  var res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    var err = await res.text();
    console.error('Supabase error:', path, res.status, err);
    return null;
  }
  var text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

// --- DEDUPLICATION ---
async function isMessageProcessed(waMessageId) {
  if (!waMessageId) return false;
  var existing = await supabaseRequest(
    'conversations?wa_message_id=eq.' + encodeURIComponent(waMessageId) + '&select=id&limit=1', 'GET'
  );
  return existing && existing.length > 0;
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
  var created = await supabaseRequest('customers', 'POST', {
    phone: phone, name: name || phone, segment: 'new', reply_mode: 'bot'
  });
  return created && created[0] ? created[0] : null;
}

// --- MESSAGE STORAGE (with language detection support) ---
async function saveMessage(customerId, message, direction, intent, waMessageId, detectedLanguage) {
  var record = {
    customer_id: customerId, direction: direction, message: message,
    intent: intent || 'general', timestamp: new Date().toISOString()
  };
  if (waMessageId) record.wa_message_id = waMessageId;
  if (detectedLanguage) record.detected_language = detectedLanguage;
  return supabaseRequest('conversations', 'POST', record);
}

// --- MEDIA MESSAGE STORAGE ---
// Stores media metadata and processing results (transcriptions, descriptions) in media_messages table
async function saveMediaMessage(customerId, waMessageId, mediaType, mediaId, metadata) {
  var record = {
    customer_id: customerId,
    wa_message_id: waMessageId || null,
    media_type: mediaType,
    media_id: mediaId || null,
    filename: (metadata && metadata.filename) || null,
    mime_type: (metadata && metadata.mimeType) || null,
    description: (metadata && metadata.description) || null,
    transcription: (metadata && metadata.transcription) || null,
    timestamp: new Date().toISOString()
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

// ============================================================
// WHATSAPP MEDIA DOWNLOAD
// Step 1: GET media URL from graph API
// Step 2: GET binary data from the returned URL
// ============================================================
async function downloadWhatsAppMedia(mediaId) {
  if (!WA_TOKEN || !mediaId) return null;

  try {
    // Step 1: Get the media URL
    var metaRes = await fetch('https://graph.facebook.com/v22.0/' + mediaId, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN }
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
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN }
    });

    if (!mediaRes.ok) {
      console.error('Media download failed:', mediaRes.status);
      return null;
    }

    var buffer = Buffer.from(await mediaRes.arrayBuffer());
    return { buffer: buffer, mimeType: mimeType };
  } catch (err) {
    console.error('Media download error:', err.message);
    return null;
  }
}

// ============================================================
// IMAGE PROCESSING - GPT-4o Vision
// Sends image to OpenAI for description / OCR
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
// Manually constructs multipart/form-data (no npm packages needed)
// ============================================================
async function transcribeAudioWithWhisper(audioBuffer, mimeType) {
  if (!OPENAI_API_KEY || !audioBuffer) return null;

  try {
    // Determine file extension from mime type
    var extMap = {
      'audio/ogg': 'ogg',
      'audio/ogg; codecs=opus': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/wav': 'wav',
      'audio/webm': 'webm',
      'audio/amr': 'amr'
    };
    // Clean mime type (remove parameters like codecs)
    var cleanMime = (mimeType || 'audio/ogg').split(';')[0].trim();
    var ext = extMap[cleanMime] || extMap[mimeType] || 'ogg';
    var filename = 'audio.' + ext;

    // Build multipart/form-data manually
    var boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex');
    var CRLF = '\r\n';

    // Part 1: the audio file
    var filePart = '--' + boundary + CRLF
      + 'Content-Disposition: form-data; name="file"; filename="' + filename + '"' + CRLF
      + 'Content-Type: ' + (cleanMime || 'audio/ogg') + CRLF
      + CRLF;

    // Part 2: the model field
    var modelPart = CRLF + '--' + boundary + CRLF
      + 'Content-Disposition: form-data; name="model"' + CRLF
      + CRLF
      + 'whisper-1' + CRLF;

    // Closing boundary
    var closingBoundary = '--' + boundary + '--' + CRLF;

    // Concatenate all parts into a single Buffer
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
// Parses the [lang:xx] tag appended by GPT and strips it from the reply
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
  customerInfo += ' | Segment: ' + (customer.segment || 'unknown');

  var systemMsg = RESTAURANT_CONTEXT + '\n\n' + customerInfo;

  // Add booking context if available
  if (bookings && bookings.length > 0) {
    systemMsg += '\n\nCustomer bookings:\n';
    bookings.forEach(function(b) {
      systemMsg += '- ' + b.date + ' ' + b.time + ' | Party: ' + b.party_size + ' | Status: ' + b.status + '\n';
    });
  }

  // Add media context if available (image description, voice transcription, etc.)
  if (mediaContext) {
    systemMsg += '\n\nMedia context from customer:\n' + mediaContext;
  }

  var messages = [{ role: 'system', content: systemMsg }];

  // Add conversation history
  if (conversationHistory && conversationHistory.length > 0) {
    messages = messages.concat(conversationHistory);
  }

  messages.push({ role: 'user', content: customerMessage });

  try {
    var response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: messages,
        max_tokens: 300,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      console.error('OpenAI API error:', response.status, await response.text());
      return null;
    }

    var data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content;
    }
    console.error('OpenAI unexpected response:', JSON.stringify(data));
    return null;
  } catch (err) {
    console.error('OpenAI error:', err);
    return null;
  }
}

// --- SEND WHATSAPP MESSAGE ---
async function sendWhatsAppReply(to, text) {
  if (!WA_TOKEN || !WA_PHONE_ID) return;
  try {
    await fetch('https://graph.facebook.com/v22.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: to, type: 'text',
        text: { body: text }
      })
    });
  } catch (e) { console.error('WhatsApp reply error:', e); }
}

// --- MAIN HANDLER ---
module.exports = async function handler(req, res) {
  // --- GET: Webhook verification ---
  if (req.method === 'GET') {
    var mode = req.query['hub.mode'];
    var token = req.query['hub.verify_token'];
    var challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // --- POST: Incoming WhatsApp messages ---
  if (req.method === 'POST') {
    // Verify webhook signature
    if (!verifyWebhookSignature(req)) {
      console.error('Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    try {
      var body = req.body;
      if (!body || !body.entry) return res.status(200).json({ status: 'no entry' });

      for (var e = 0; e < body.entry.length; e++) {
        var entry = body.entry[e];
        var changes = entry.changes || [];

        for (var c = 0; c < changes.length; c++) {
          var change = changes[c];
          if (change.field !== 'messages') continue;
          var value = change.value || {};
          var waMessages = value.messages || [];
          var contacts = value.contacts || [];

          for (var i = 0; i < waMessages.length; i++) {
            var msg = waMessages[i];
            var contact = contacts[i] || {};
            var phone = msg.from;
            var waMessageId = msg.id;
            var name = contact.profile ? contact.profile.name : null;

            // Deduplication check
            if (await isMessageProcessed(waMessageId)) {
              console.log('Duplicate message skipped:', waMessageId);
              continue;
            }

            // Upsert customer
            var customer = await upsertCustomer(phone, name);
            if (!customer) continue;
            var customerId = customer.id;

            // --- Process message by type ---
            var messageText = '';
            var mediaContext = null;

            if (msg.type === 'text') {
              messageText = msg.text ? msg.text.body : '';

            } else if (msg.type === 'image') {
              var imgMediaId = msg.image ? msg.image.id : null;
              var imgCaption = msg.image ? msg.image.caption : null;
              messageText = imgCaption || '[Image received]';

              if (imgMediaId) {
                var imgData = await downloadWhatsAppMedia(imgMediaId);
                if (imgData) {
                  var description = await describeImageWithVision(imgData.buffer, imgData.mimeType, imgCaption);
                  if (description) {
                    mediaContext = 'Customer sent an image. Description: ' + description;
                    await saveMediaMessage(customerId, waMessageId, 'image', imgMediaId, {
                      mimeType: imgData.mimeType, description: description
                    });
                  }
                }
              }

            } else if (msg.type === 'audio') {
              var audioMediaId = msg.audio ? msg.audio.id : null;
              var audioMime = msg.audio ? msg.audio.mime_type : null;
              messageText = '[Voice message]';

              if (audioMediaId) {
                var audioData = await downloadWhatsAppMedia(audioMediaId);
                if (audioData) {
                  var transcription = await transcribeAudioWithWhisper(audioData.buffer, audioMime || audioData.mimeType);
                  if (transcription) {
                    messageText = transcription;
                    mediaContext = 'Customer sent a voice message. Transcription: ' + transcription;
                    await saveMediaMessage(customerId, waMessageId, 'audio', audioMediaId, {
                      mimeType: audioMime, transcription: transcription
                    });
                  }
                }
              }

            } else if (msg.type === 'document') {
              var docName = msg.document ? msg.document.filename : 'document';
              messageText = '[Document: ' + docName + ']';
              mediaContext = 'Customer sent a document named: ' + docName;
              if (msg.document && msg.document.id) {
                await saveMediaMessage(customerId, waMessageId, 'document', msg.document.id, {
                  filename: docName, mimeType: msg.document.mime_type
                });
              }

            } else if (msg.type === 'video') {
              messageText = msg.video && msg.video.caption ? msg.video.caption : '[Video received]';
              mediaContext = 'Customer sent a video.';
              if (msg.video && msg.video.id) {
                await saveMediaMessage(customerId, waMessageId, 'video', msg.video.id, {
                  mimeType: msg.video.mime_type
                });
              }

            } else if (msg.type === 'sticker') {
              messageText = '[Sticker]';

            } else if (msg.type === 'location') {
              var lat = msg.location ? msg.location.latitude : '';
              var lon = msg.location ? msg.location.longitude : '';
              messageText = '[Location: ' + lat + ', ' + lon + ']';

            } else if (msg.type === 'contacts') {
              messageText = '[Contact shared]';

            } else {
              messageText = '[' + (msg.type || 'unknown') + ' message]';
            }

            // Detect intent
            var intent = detectIntent(messageText);

            // Save inbound message
            await saveMessage(customerId, messageText, 'inbound', intent, waMessageId);

            // Check reply mode
            var replyMode = customer.reply_mode || 'bot';
            if (customer.opted_out) {
              console.log('Customer ' + phone + ' opted out, skipping bot reply');
              continue;
            }
            if (replyMode === 'manual') {
              console.log('Customer ' + phone + ' is in manual mode, skipping bot reply');
              continue;
            }

            // Generate AI reply
            var history = await getConversationHistory(customerId, 10);
            var bookings = await getCustomerBookings(customerId);
            var aiReply = await generateAIReply(messageText, history, customer, intent, bookings, mediaContext);

            if (aiReply) {
              var parsed = extractLanguageFromReply(aiReply);
              var cleanReply = parsed.text;
              var detectedLang = parsed.language;

              await sendWhatsAppReply(phone, cleanReply);
              await saveMessage(customerId, cleanReply, 'outbound', intent, null, detectedLang);
            } else {
              var fallback = 'Thank you for your message! Our team will get back to you shortly.\n\nCall us: +94 77 949 4394';
              await sendWhatsAppReply(phone, fallback);
              await saveMessage(customerId, fallback, 'outbound', intent);
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
