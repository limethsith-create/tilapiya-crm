// Vercel Serverless Function - Outbox / Batch WhatsApp Messaging for Tilapiya CRM
// Handles batch creation, sending, pausing, cancellation, and stats

const crypto = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID;
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET;

// --- CORS ---
function setCorsHeaders(res, req) {
  var allowed = [DASHBOARD_ORIGIN, 'https://tilapiya-crm.vercel.app', 'https://tilapiya-crm.netlify.app'].filter(Boolean);
  var reqOrigin = req && req.headers ? req.headers.origin || '' : '';
  var origin = allowed.includes(reqOrigin) ? reqOrigin : (allowed[0] || '*');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dashboard-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// --- AUTH ---
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

// --- SUPABASE HELPER ---
async function supabaseRequest(path, method, body, extraHeaders) {
  var headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
  if (method === 'POST') headers['Prefer'] = 'return=representation';
  if (method === 'PATCH') headers['Prefer'] = 'return=representation';
  if (extraHeaders) {
    for (var k in extraHeaders) headers[k] = extraHeaders[k];
  }
  var r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    var err = await r.text();
    console.error('Supabase error:', method, path, r.status, err);
    return null;
  }
  var text = await r.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

// --- SEGMENT FILTER BUILDER ---
// Returns Supabase REST filter query string for the given segment
function buildSegmentFilter(segment) {
  switch (segment) {
    case 'all':
      return '';
    case 'new':
      return '&segment=eq.new';
    case 'returning':
      return '&segment=eq.returning';
    case 'vip':
      return '&segment=eq.vip';
    case 'regular':
      return '&segment=eq.regular';
    case 'lapsed':
      // Customers with no contact in 60+ days
      var cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      return '&last_contact=lt.' + cutoff;
    case 'gold':
      // Customers with Gold tier in loyalty table - handled separately
      return '__loyalty_gold__';
    default:
      return '&segment=eq.' + encodeURIComponent(segment);
  }
}

// --- RESOLVE TEMPLATE VARIABLES ---
function resolveTemplate(template, customer, loyalty) {
  var now = new Date();
  var dateStr = now.toLocaleDateString('en-LK', { year: 'numeric', month: 'long', day: 'numeric' });
  var result = template;
  result = result.replace(/\{\{name\}\}/gi, customer.name || 'Valued Customer');
  result = result.replace(/\{\{phone\}\}/gi, customer.phone || '');
  result = result.replace(/\{\{date\}\}/gi, dateStr);
  result = result.replace(/\{\{points\}\}/gi, String((loyalty && loyalty.total_points) || 0));
  result = result.replace(/\{\{tier\}\}/gi, (loyalty && loyalty.tier) || 'Bronze');
  return result;
}

// --- SEND SINGLE WHATSAPP MESSAGE ---
async function sendWhatsAppMessage(to, message) {
  var response = await fetch('https://graph.facebook.com/v22.0/' + WA_PHONE_ID + '/messages', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + WA_TOKEN,
      'Content-Type': 'application/json'
    },
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
    return { ok: false, error: data };
  }
  var waMessageId = data.messages && data.messages[0] ? data.messages[0].id : null;
  return { ok: true, wa_message_id: waMessageId };
}

// --- DELAY HELPER ---
function delay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ========== ACTION HANDLERS ==========

// --- CREATE BATCH ---
async function createBatch(body) {
  var name = body.name;
  var messageTemplate = body.message_template;
  var segment = body.segment || 'all';
  var scheduledAt = body.scheduled_at || null;

  if (!name || !messageTemplate) {
    return { status: 400, body: { error: 'Missing name or message_template' } };
  }

  // Fetch recipients based on segment
  var customers;
  if (segment === 'gold') {
    // Gold tier requires joining with loyalty table
    // First get gold loyalty customer IDs
    var goldLoyalty = await supabaseRequest(
      'loyalty?tier=eq.Gold&select=customer_id,total_points,tier', 'GET'
    );
    if (!goldLoyalty || goldLoyalty.length === 0) {
      return { status: 200, body: { error: 'No customers found for segment: gold', batch: null } };
    }
    var goldIds = goldLoyalty.map(function(l) { return l.customer_id; });
    // Fetch those customers, excluding opted out
    customers = await supabaseRequest(
      'customers?id=in.(' + goldIds.join(',') + ')&opted_out=not.is.true&select=id,phone,name', 'GET'
    );
    // Attach loyalty data
    if (customers) {
      var loyaltyMap = {};
      for (var g = 0; g < goldLoyalty.length; g++) {
        loyaltyMap[goldLoyalty[g].customer_id] = goldLoyalty[g];
      }
      for (var gc = 0; gc < customers.length; gc++) {
        customers[gc]._loyalty = loyaltyMap[customers[gc].id] || null;
      }
    }
  } else {
    var filter = buildSegmentFilter(segment);
    customers = await supabaseRequest(
      'customers?opted_out=not.is.true' + filter + '&select=id,phone,name', 'GET'
    );
  }

  if (!customers || customers.length === 0) {
    return { status: 200, body: { error: 'No customers found for segment: ' + segment, batch: null } };
  }

  // For non-gold segments, fetch loyalty data for template resolution
  var loyaltyMap = {};
  if (segment !== 'gold' && /\{\{points\}\}|\{\{tier\}\}/i.test(messageTemplate)) {
    var customerIds = customers.map(function(c) { return c.id; });
    // Fetch in chunks of 50 to avoid URL length issues
    for (var ci = 0; ci < customerIds.length; ci += 50) {
      var chunk = customerIds.slice(ci, ci + 50);
      var loyaltyRows = await supabaseRequest(
        'loyalty?customer_id=in.(' + chunk.join(',') + ')&select=customer_id,total_points,tier', 'GET'
      );
      if (loyaltyRows) {
        for (var lr = 0; lr < loyaltyRows.length; lr++) {
          loyaltyMap[loyaltyRows[lr].customer_id] = loyaltyRows[lr];
        }
      }
    }
  }

  // Create the batch record
  var batchRecord = {
    name: name,
    message_template: messageTemplate,
    segment: segment,
    status: 'draft',
    total_count: customers.length,
    sent_count: 0,
    failed_count: 0,
    scheduled_at: scheduledAt,
    created_at: new Date().toISOString()
  };

  var batchResult = await supabaseRequest('outbox_batches', 'POST', batchRecord);
  if (!batchResult || !batchResult[0]) {
    return { status: 500, body: { error: 'Failed to create batch record' } };
  }
  var batch = batchResult[0];

  // Create individual message records
  var messageRecords = [];
  for (var m = 0; m < customers.length; m++) {
    var cust = customers[m];
    var loyalty = cust._loyalty || loyaltyMap[cust.id] || null;
    var resolvedMessage = resolveTemplate(messageTemplate, cust, loyalty);

    messageRecords.push({
      batch_id: batch.id,
      customer_id: cust.id,
      phone: cust.phone,
      customer_name: cust.name || cust.phone,
      message: resolvedMessage,
      status: 'queued',
      created_at: new Date().toISOString()
    });
  }

  // Insert messages in chunks of 100
  var insertedCount = 0;
  for (var mc = 0; mc < messageRecords.length; mc += 100) {
    var msgChunk = messageRecords.slice(mc, mc + 100);
    var insertResult = await supabaseRequest('outbox_messages', 'POST', msgChunk);
    if (insertResult) {
      insertedCount += insertResult.length;
    } else {
      console.error('Failed to insert message chunk at offset', mc);
    }
  }

  console.log('Batch created:', batch.id, 'with', insertedCount, 'messages for segment:', segment);

  return {
    status: 200,
    body: {
      batch: batch,
      recipient_count: insertedCount
    }
  };
}

// --- LIST BATCHES ---
async function listBatches() {
  var batches = await supabaseRequest(
    'outbox_batches?select=*&order=created_at.desc', 'GET'
  );
  return { status: 200, body: { batches: batches || [] } };
}

// --- GET BATCH ---
async function getBatch(body) {
  var batchId = body.batch_id;
  if (!batchId) return { status: 400, body: { error: 'Missing batch_id' } };

  var batches = await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId) + '&select=*', 'GET'
  );
  if (!batches || batches.length === 0) {
    return { status: 404, body: { error: 'Batch not found' } };
  }

  var page = body.page || 1;
  var perPage = body.per_page || 50;
  var offset = (page - 1) * perPage;

  var messages = await supabaseRequest(
    'outbox_messages?batch_id=eq.' + encodeURIComponent(batchId) +
    '&select=*&order=created_at.asc&limit=' + perPage + '&offset=' + offset, 'GET'
  );

  // Get total count via HEAD request with Prefer: count=exact
  var countHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Prefer': 'count=exact',
    'Range-Unit': 'items',
    'Range': '0-0'
  };
  var countRes = await fetch(
    SUPABASE_URL + '/rest/v1/outbox_messages?batch_id=eq.' + encodeURIComponent(batchId) + '&select=id',
    { method: 'GET', headers: countHeaders }
  );
  var contentRange = countRes.headers.get('content-range') || '';
  var totalMessages = 0;
  var rangeMatch = contentRange.match(/\/(\d+)/);
  if (rangeMatch) totalMessages = parseInt(rangeMatch[1], 10);

  return {
    status: 200,
    body: {
      batch: batches[0],
      messages: messages || [],
      pagination: {
        page: page,
        per_page: perPage,
        total: totalMessages,
        total_pages: Math.ceil(totalMessages / perPage) || 1
      }
    }
  };
}

// --- SEND BATCH ---
async function sendBatch(body) {
  var batchId = body.batch_id;
  if (!batchId) return { status: 400, body: { error: 'Missing batch_id' } };

  if (!WA_TOKEN || !WA_PHONE_ID) {
    return { status: 500, body: { error: 'WhatsApp not configured' } };
  }

  // Get batch
  var batches = await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId) + '&select=*', 'GET'
  );
  if (!batches || batches.length === 0) {
    return { status: 404, body: { error: 'Batch not found' } };
  }
  var batch = batches[0];

  if (batch.status !== 'draft' && batch.status !== 'paused') {
    return { status: 400, body: { error: 'Batch status is ' + batch.status + ', can only send draft or paused batches' } };
  }

  // Mark batch as sending
  await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId), 'PATCH',
    { status: 'sending', started_at: new Date().toISOString() }
  );

  // Get all queued messages for this batch
  var messages = await supabaseRequest(
    'outbox_messages?batch_id=eq.' + encodeURIComponent(batchId) +
    '&status=eq.queued&select=*&order=created_at.asc&limit=10000', 'GET'
  );

  if (!messages || messages.length === 0) {
    await supabaseRequest(
      'outbox_batches?id=eq.' + encodeURIComponent(batchId), 'PATCH',
      { status: 'completed', completed_at: new Date().toISOString() }
    );
    return { status: 200, body: { batch_id: batchId, sent: 0, failed: 0, message: 'No queued messages to send' } };
  }

  var sentCount = batch.sent_count || 0;
  var failedCount = batch.failed_count || 0;

  console.log('Starting batch send:', batchId, 'messages:', messages.length);

  for (var i = 0; i < messages.length; i++) {
    // Re-check batch status to support pausing mid-send
    if (i > 0 && i % 10 === 0) {
      var currentBatch = await supabaseRequest(
        'outbox_batches?id=eq.' + encodeURIComponent(batchId) + '&select=status', 'GET'
      );
      if (currentBatch && currentBatch[0] && currentBatch[0].status === 'paused') {
        console.log('Batch', batchId, 'paused at message', i, 'of', messages.length);
        return {
          status: 200,
          body: {
            batch_id: batchId,
            status: 'paused',
            sent: sentCount,
            failed: failedCount,
            remaining: messages.length - i
          }
        };
      }
      if (currentBatch && currentBatch[0] && currentBatch[0].status === 'cancelled') {
        console.log('Batch', batchId, 'cancelled at message', i);
        return {
          status: 200,
          body: {
            batch_id: batchId,
            status: 'cancelled',
            sent: sentCount,
            failed: failedCount
          }
        };
      }
    }

    var msg = messages[i];
    var cleanPhone = msg.phone.replace(/\s/g, '');

    try {
      var result = await sendWhatsAppMessage(cleanPhone, msg.message);

      if (result.ok) {
        sentCount++;
        await supabaseRequest(
          'outbox_messages?id=eq.' + encodeURIComponent(msg.id), 'PATCH',
          {
            status: 'sent',
            wa_message_id: result.wa_message_id,
            sent_at: new Date().toISOString()
          }
        );
      } else {
        failedCount++;
        var errorDetail = result.error ? JSON.stringify(result.error).slice(0, 500) : 'Unknown error';
        await supabaseRequest(
          'outbox_messages?id=eq.' + encodeURIComponent(msg.id), 'PATCH',
          {
            status: 'failed',
            error: errorDetail,
            sent_at: new Date().toISOString()
          }
        );
      }
    } catch (sendErr) {
      failedCount++;
      console.error('Send error for message', msg.id, ':', sendErr.message);
      await supabaseRequest(
        'outbox_messages?id=eq.' + encodeURIComponent(msg.id), 'PATCH',
        {
          status: 'failed',
          error: sendErr.message.slice(0, 500),
          sent_at: new Date().toISOString()
        }
      );
    }

    // Update batch counters periodically (every 5 messages)
    if (i % 5 === 4 || i === messages.length - 1) {
      await supabaseRequest(
        'outbox_batches?id=eq.' + encodeURIComponent(batchId), 'PATCH',
        { sent_count: sentCount, failed_count: failedCount }
      );
    }

    // Rate limit: 1 second between messages
    if (i < messages.length - 1) {
      await delay(1000);
    }
  }

  // Mark batch as completed
  await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId), 'PATCH',
    {
      status: 'completed',
      sent_count: sentCount,
      failed_count: failedCount,
      completed_at: new Date().toISOString()
    }
  );

  console.log('Batch completed:', batchId, 'sent:', sentCount, 'failed:', failedCount);

  return {
    status: 200,
    body: {
      batch_id: batchId,
      status: 'completed',
      sent: sentCount,
      failed: failedCount
    }
  };
}

// --- PAUSE BATCH ---
async function pauseBatch(body) {
  var batchId = body.batch_id;
  if (!batchId) return { status: 400, body: { error: 'Missing batch_id' } };

  var batches = await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId) + '&select=status', 'GET'
  );
  if (!batches || batches.length === 0) {
    return { status: 404, body: { error: 'Batch not found' } };
  }
  if (batches[0].status !== 'sending') {
    return { status: 400, body: { error: 'Can only pause a sending batch, current status: ' + batches[0].status } };
  }

  await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId), 'PATCH',
    { status: 'paused' }
  );

  return { status: 200, body: { batch_id: batchId, status: 'paused' } };
}

// --- CANCEL BATCH ---
async function cancelBatch(body) {
  var batchId = body.batch_id;
  if (!batchId) return { status: 400, body: { error: 'Missing batch_id' } };

  var batches = await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId) + '&select=status', 'GET'
  );
  if (!batches || batches.length === 0) {
    return { status: 404, body: { error: 'Batch not found' } };
  }
  var allowed = ['draft', 'sending', 'paused'];
  if (allowed.indexOf(batches[0].status) === -1) {
    return { status: 400, body: { error: 'Cannot cancel batch with status: ' + batches[0].status } };
  }

  // Mark remaining queued messages as cancelled
  await supabaseRequest(
    'outbox_messages?batch_id=eq.' + encodeURIComponent(batchId) + '&status=eq.queued', 'PATCH',
    { status: 'cancelled' }
  );

  await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId), 'PATCH',
    { status: 'cancelled', completed_at: new Date().toISOString() }
  );

  return { status: 200, body: { batch_id: batchId, status: 'cancelled' } };
}

// --- DELETE BATCH ---
async function deleteBatch(body) {
  var batchId = body.batch_id;
  if (!batchId) return { status: 400, body: { error: 'Missing batch_id' } };

  var batches = await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId) + '&select=status', 'GET'
  );
  if (!batches || batches.length === 0) {
    return { status: 404, body: { error: 'Batch not found' } };
  }
  var deletable = ['draft', 'completed', 'cancelled'];
  if (deletable.indexOf(batches[0].status) === -1) {
    return { status: 400, body: { error: 'Cannot delete batch with status: ' + batches[0].status + '. Pause or cancel first.' } };
  }

  // Delete messages first (FK constraint)
  await supabaseRequest(
    'outbox_messages?batch_id=eq.' + encodeURIComponent(batchId), 'DELETE'
  );

  // Delete the batch
  await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId), 'DELETE'
  );

  return { status: 200, body: { batch_id: batchId, deleted: true } };
}

// --- BATCH STATS ---
async function batchStats(body) {
  var batchId = body.batch_id;
  if (!batchId) return { status: 400, body: { error: 'Missing batch_id' } };

  var batches = await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId) + '&select=*', 'GET'
  );
  if (!batches || batches.length === 0) {
    return { status: 404, body: { error: 'Batch not found' } };
  }

  // Count messages by status
  var statuses = ['queued', 'sent', 'failed', 'cancelled'];
  var counts = {};
  for (var si = 0; si < statuses.length; si++) {
    var s = statuses[si];
    var countHeaders = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Prefer': 'count=exact',
      'Range-Unit': 'items',
      'Range': '0-0'
    };
    var countRes = await fetch(
      SUPABASE_URL + '/rest/v1/outbox_messages?batch_id=eq.' + encodeURIComponent(batchId) +
      '&status=eq.' + s + '&select=id',
      { method: 'GET', headers: countHeaders }
    );
    var contentRange = countRes.headers.get('content-range') || '';
    var rangeMatch = contentRange.match(/\/(\d+)/);
    counts[s] = rangeMatch ? parseInt(rangeMatch[1], 10) : 0;
  }

  return {
    status: 200,
    body: {
      batch: batches[0],
      stats: counts,
      total: counts.queued + counts.sent + counts.failed + counts.cancelled
    }
  };
}

// ========== MAIN HANDLER ==========
module.exports = async function handler(req, res) {
  setCorsHeaders(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Unauthorized. Provide X-Dashboard-Key header.' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Database not configured.' });
  }

  // GET: simple batch listing
  if (req.method === 'GET') {
    var result = await listBatches();
    return res.status(result.status).json(result.body);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var action = req.body && req.body.action;
  if (!action) {
    return res.status(400).json({ error: 'Missing action field' });
  }

  try {
    var result;
    switch (action) {
      case 'create_batch':
        result = await createBatch(req.body);
        break;
      case 'list_batches':
        result = await listBatches();
        break;
      case 'get_batch':
        result = await getBatch(req.body);
        break;
      case 'send_batch':
        result = await sendBatch(req.body);
        break;
      case 'pause_batch':
        result = await pauseBatch(req.body);
        break;
      case 'cancel_batch':
        result = await cancelBatch(req.body);
        break;
      case 'delete_batch':
        result = await deleteBatch(req.body);
        break;
      case 'batch_stats':
        result = await batchStats(req.body);
        break;
      default:
        result = { status: 400, body: { error: 'Unknown action: ' + action } };
    }
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Outbox error:', action, err);
    return res.status(500).json({ error: err.message });
  }
};
