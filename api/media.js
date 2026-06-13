// Vercel Serverless Function - Media Processing for Tilapiya CRM
// Handles: WhatsApp media download, voice transcription, image description,
// language detection/translation, and media record storage.
// Called internally by webhook, also exposed as POST handler for dashboard use.

const crypto = require('crypto');
const { isAuthorized } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

// Size cap for media downloads (3 MB)
const MAX_MEDIA_BYTES = 3 * 1024 * 1024;

// --- CORS (same pattern as send.js) ---

function setCorsHeaders(res, req) {
  var allowed = [DASHBOARD_ORIGIN, 'https://tilapiya-crm.vercel.app', 'https://tilapiya-crm.netlify.app'].filter(Boolean);
  var reqOrigin = req && req.headers ? req.headers.origin || '' : '';
  var origin = allowed.includes(reqOrigin) ? reqOrigin : (allowed[0] || '*');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dashboard-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// Error helper carrying an HTTP status code
function httpError(statusCode, message) {
  var err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

// --- MIME TYPE HELPERS ---

var AUDIO_MIME_EXTENSIONS = {
  'audio/ogg': 'ogg',
  'audio/ogg; codecs=opus': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm'
};

function getAudioExtension(mimeType) {
  if (!mimeType) return 'ogg';
  var base = mimeType.split(';')[0].trim().toLowerCase();
  return AUDIO_MIME_EXTENSIONS[base] || AUDIO_MIME_EXTENSIONS[mimeType.toLowerCase()] || 'ogg';
}

// =============================================================
// 1. DOWNLOAD MEDIA FROM WHATSAPP
// =============================================================

async function download_media(media_id) {
  if (!WA_TOKEN) throw new Error('META_WHATSAPP_TOKEN not configured');
  if (!media_id) throw new Error('media_id is required');

  console.log('[media] Downloading media:', media_id);

  // Step 1: Get the media URL from Meta
  var metaRes = await fetch('https://graph.facebook.com/v22.0/' + media_id, {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + WA_TOKEN },
    signal: AbortSignal.timeout(15000)
  });

  if (!metaRes.ok) {
    var errText = await metaRes.text();
    console.error('[media] Meta media URL fetch failed:', metaRes.status, errText);
    throw new Error('Failed to get media URL from Meta: ' + metaRes.status);
  }

  var metaData = await metaRes.json();
  var mediaUrl = metaData.url;
  var mimeType = metaData.mime_type || 'application/octet-stream';

  if (!mediaUrl) {
    throw new Error('No media URL returned by Meta for media_id: ' + media_id);
  }

  // Size cap: refuse oversized media before downloading
  if (metaData.file_size && Number(metaData.file_size) > MAX_MEDIA_BYTES) {
    throw httpError(413, 'Media too large: ' + metaData.file_size + ' bytes (max ' + MAX_MEDIA_BYTES + ' bytes / 3MB)');
  }

  // Step 2: Download the actual binary
  var downloadRes = await fetch(mediaUrl, {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + WA_TOKEN },
    signal: AbortSignal.timeout(20000)
  });

  if (!downloadRes.ok) {
    var dlErr = await downloadRes.text();
    console.error('[media] Media binary download failed:', downloadRes.status, dlErr);
    throw new Error('Failed to download media binary: ' + downloadRes.status);
  }

  var arrayBuffer = await downloadRes.arrayBuffer();
  var buffer = Buffer.from(arrayBuffer);

  // Backstop size check (Meta does not always report file_size)
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw httpError(413, 'Media too large: ' + buffer.length + ' bytes (max ' + MAX_MEDIA_BYTES + ' bytes / 3MB)');
  }

  console.log('[media] Downloaded:', media_id, 'size=' + buffer.length, 'mime=' + mimeType);

  return { buffer: buffer, mime_type: mimeType, file_size: buffer.length };
}

// =============================================================
// 2. TRANSCRIBE VOICE / AUDIO (OpenAI Whisper)
// =============================================================

async function transcribe_voice(media_buffer, mime_type) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  if (!media_buffer || media_buffer.length === 0) throw new Error('Empty media buffer');

  var ext = getAudioExtension(mime_type);
  var filename = 'voice.' + ext;

  console.log('[media] Transcribing audio: mime=' + mime_type, 'ext=' + ext, 'size=' + media_buffer.length);

  // Build multipart form data manually for Node.js fetch
  var boundary = '----FormBoundary' + crypto.randomBytes(16).toString('hex');
  var parts = [];

  // model field
  parts.push(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="model"\r\n\r\n' +
    'whisper-1\r\n'
  );

  // response_format field - request verbose_json for language detection
  parts.push(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="response_format"\r\n\r\n' +
    'verbose_json\r\n'
  );

  // file field
  parts.push(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
    'Content-Type: ' + (mime_type || 'audio/ogg') + '\r\n\r\n'
  );

  var endPart = '\r\n--' + boundary + '--\r\n';

  // Combine into a single buffer
  var bodyParts = [
    Buffer.from(parts.join(''), 'utf-8'),
    media_buffer,
    Buffer.from(endPart, 'utf-8')
  ];
  var bodyBuffer = Buffer.concat(bodyParts);

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
    var errText = await response.text();
    console.error('[media] Whisper API error:', response.status, errText);
    throw new Error('Whisper transcription failed: ' + response.status);
  }

  var data = await response.json();
  var text = (data.text || '').trim();
  var language = data.language || 'unknown';

  console.log('[media] Transcription done: lang=' + language, 'length=' + text.length);

  return { text: text, language: language };
}

// =============================================================
// 3. DESCRIBE IMAGE (OpenAI GPT-4o Vision)
// =============================================================

async function describe_image(media_buffer, mime_type) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  if (!media_buffer || media_buffer.length === 0) throw new Error('Empty media buffer');

  var base64 = media_buffer.toString('base64');
  var dataUrl = 'data:' + (mime_type || 'image/jpeg') + ';base64,' + base64;

  console.log('[media] Describing image: mime=' + mime_type, 'size=' + media_buffer.length);

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
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Describe what you see in this image. If there is text, transcribe it. If it\'s a menu, receipt, or document, extract the key information. Be concise.'
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'auto' }
            }
          ]
        }
      ],
      max_tokens: 500,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    var errText = await response.text();
    console.error('[media] GPT-4o vision error:', response.status, errText);
    throw new Error('Image description failed: ' + response.status);
  }

  var data = await response.json();
  var description = '';
  if (data.choices && data.choices[0] && data.choices[0].message) {
    description = data.choices[0].message.content.trim();
  }

  console.log('[media] Image described: length=' + description.length);

  return { description: description };
}

// =============================================================
// 4. DETECT LANGUAGE & TRANSLATE (OpenAI GPT-4o)
// =============================================================

async function detect_and_translate(text, source_hint) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
  if (!text || text.trim().length === 0) {
    return { detected_language: 'unknown', original_text: text, translated_text: text, is_english: true };
  }

  var systemPrompt = [
    'You are a language detection and translation assistant.',
    'Detect the language of the user\'s text. Common languages: Sinhala, Tamil, English, but handle any language.',
    source_hint ? 'Hint: the text may be in ' + source_hint + '.' : '',
    '',
    'Respond ONLY with valid JSON (no markdown, no code fences):',
    '{',
    '  "detected_language": "Language Name",',
    '  "is_english": true/false,',
    '  "translated_text": "English translation if not English, otherwise same as original"',
    '}'
  ].filter(Boolean).join('\n');

  console.log('[media] Detecting language for text length=' + text.length);

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
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ],
      max_tokens: 500,
      temperature: 0.1
    })
  });

  if (!response.ok) {
    var errText = await response.text();
    console.error('[media] GPT-4o translate error:', response.status, errText);
    throw new Error('Language detection/translation failed: ' + response.status);
  }

  var data = await response.json();
  var content = '';
  if (data.choices && data.choices[0] && data.choices[0].message) {
    content = data.choices[0].message.content.trim();
  }

  // Parse the JSON response, stripping markdown fences if present
  var cleaned = content.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  var result;
  try {
    result = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error('[media] Failed to parse translation JSON:', cleaned);
    return {
      detected_language: 'unknown',
      original_text: text,
      translated_text: text,
      is_english: true
    };
  }

  var output = {
    detected_language: result.detected_language || 'unknown',
    original_text: text,
    translated_text: result.translated_text || text,
    is_english: !!result.is_english
  };

  console.log('[media] Language detected:', output.detected_language, 'is_english=' + output.is_english);

  return output;
}

// =============================================================
// 5. SAVE MEDIA RECORD TO SUPABASE
// =============================================================

async function save_media_record(data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase not configured');
  if (!data) throw new Error('No data provided');

  // Columns match media_messages schema (005) + additions from migration 006
  // (wa_message_id, file_size, original_filename, processed_at).
  var record = {
    customer_id: data.customer_id || null,
    conversation_id: data.conversation_id || null,
    wa_message_id: data.wa_message_id || null,
    wa_media_id: data.wa_media_id || data.media_id || null,
    media_type: data.media_type || 'document',
    mime_type: data.mime_type || null,
    file_size: data.file_size || null,
    transcription: data.transcription || null,
    description: data.description || null,
    detected_language: data.detected_language || null,
    original_text: data.original_text || null,
    translated_text: data.translated_text || null,
    original_filename: data.original_filename || null,
    processed_at: new Date().toISOString()
  };

  console.log('[media] Saving media record: type=' + record.media_type, 'customer=' + record.customer_id);

  var result = await supabaseRequest('media_messages', 'POST', record);

  if (!result) {
    console.error('[media] Failed to save media record');
    throw new Error('Failed to save media record to database');
  }

  console.log('[media] Media record saved:', result[0] ? result[0].id : 'ok');

  return result[0] || result;
}

// =============================================================
// VERCEL HANDLER (POST with action field)
// =============================================================

module.exports = async function handler(req, res) {
  setCorsHeaders(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized. Provide X-Dashboard-Key header.' });
  }

  var action = req.body && req.body.action;
  if (!action) {
    return res.status(400).json({ error: 'Missing action field. Valid actions: download_media, transcribe_voice, describe_image, detect_and_translate, save_media_record' });
  }

  try {
    switch (action) {
      case 'download_media': {
        if (!req.body.media_id) return res.status(400).json({ error: 'Missing media_id' });
        var dlResult = await download_media(req.body.media_id);
        // Return buffer as base64 for JSON transport
        return res.status(200).json({
          status: 'ok',
          mime_type: dlResult.mime_type,
          file_size: dlResult.file_size,
          data_base64: dlResult.buffer.toString('base64')
        });
      }

      case 'transcribe_voice': {
        if (!req.body.data_base64) return res.status(400).json({ error: 'Missing data_base64' });
        var audioBuf = Buffer.from(req.body.data_base64, 'base64');
        var txResult = await transcribe_voice(audioBuf, req.body.mime_type || 'audio/ogg');
        return res.status(200).json({ status: 'ok', text: txResult.text, language: txResult.language });
      }

      case 'describe_image': {
        if (!req.body.data_base64) return res.status(400).json({ error: 'Missing data_base64' });
        var imgBuf = Buffer.from(req.body.data_base64, 'base64');
        var imgResult = await describe_image(imgBuf, req.body.mime_type || 'image/jpeg');
        return res.status(200).json({ status: 'ok', description: imgResult.description });
      }

      case 'detect_and_translate': {
        if (!req.body.text) return res.status(400).json({ error: 'Missing text' });
        var transResult = await detect_and_translate(req.body.text, req.body.source_hint || null);
        return res.status(200).json({ status: 'ok', result: transResult });
      }

      case 'save_media_record': {
        if (!req.body.record) return res.status(400).json({ error: 'Missing record object' });
        var saveResult = await save_media_record(req.body.record);
        return res.status(200).json({ status: 'ok', record: saveResult });
      }

      default:
        return res.status(400).json({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    console.error('[media] Handler error:', action, err.message);
    var status = err.statusCode === 413 ? 413 : 500;
    return res.status(status).json({ error: err.message });
  }
};

// --- NAMED EXPORTS FOR INTERNAL USE (by webhook.js etc.) ---
module.exports.download_media = download_media;
module.exports.transcribe_voice = transcribe_voice;
module.exports.describe_image = describe_image;
module.exports.detect_and_translate = detect_and_translate;
module.exports.save_media_record = save_media_record;
