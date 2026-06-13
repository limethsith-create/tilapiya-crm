// Vercel Serverless Function - Outbox / Batch WhatsApp Messaging for Tilapiya CRM
// Handles batch creation, sending (chunked + atomic claims), pausing,
// cancellation, and stats.
//
// send_batch processes at most 20 messages per invocation and returns
// { status: 'in_progress', remaining: N } until done — callers re-invoke.

const { isAuthorized } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WA_TOKEN = process.env.META_WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.META_PHONE_NUMBER_ID;
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

const CHUNK_SIZE = 20;       // messages per invocation
const SEND_DELAY_MS = 350;   // delay between sends

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

// --- EXACT COUNT HELPER (HEAD-style request with count=exact) ---
async function countRows(pathWithFilters) {
  var countHeaders = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Prefer': 'count=exact',
    'Range-Unit': 'items',
    'Range': '0-0'
  };
  try {
    var countRes = await fetch(SUPABASE_URL + '/rest/v1/' + pathWithFilters, {
      method: 'GET', headers: countHeaders, signal: AbortSignal.timeout(15000)
    });
    var contentRange = countRes.headers.get('content-range') || '';
    var rangeMatch = contentRange.match(/\/(\d+)/);
    return rangeMatch ? parseInt(rangeMatch[1], 10) : 0;
  } catch (e) {
    console.error('Count request failed:', pathWithFilters, e.message);
    return 0;
  }
}

// --- SEGMENT FILTER BUILDER ---
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
      return '&last_contact=lt.' + encodeURIComponent(cutoff);
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
  var goldLoyaltyMap = {};
  if (segment === 'gold') {
    // Gold tier requires joining with loyalty table
    var goldLoyalty = await supabaseRequest(
      'loyalty?tier=eq.Gold&select=customer_id,total_points,tier', 'GET'
    );
    if (!goldLoyalty || goldLoyalty.length === 0) {
      return { status: 200, body: { error: 'No customers found for segment: gold', batch: null } };
    }
    var goldIds = goldLoyalty.map(function(l) { return l.customer_id; });
    for (var g = 0; g < goldLoyalty.length; g++) {
      goldLoyaltyMap[goldLoyalty[g].customer_id] = goldLoyalty[g];
    }
    // Fetch those customers in chunks of 50 (avoid URL length issues), excluding opted out
    customers = [];
    for (var gi = 0; gi < goldIds.length; gi += 50) {
      var goldChunk = goldIds.slice(gi, gi + 50);
      var custChunk = await supabaseRequest(
        'customers?id=in.(' + goldChunk.map(encodeURIComponent).join(',') + ')&opted_out=not.is.true&select=id,phone,name', 'GET'
      );
      if (custChunk) customers = customers.concat(custChunk);
    }
    // Attach loyalty data
    for (var gc = 0; gc < customers.length; gc++) {
      customers[gc]._loyalty = goldLoyaltyMap[customers[gc].id] || null;
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
        'loyalty?customer_id=in.(' + chunk.map(encodeURIComponent).join(',') + ')&select=customer_id,total_points,tier', 'GET'
      );
      if (loyaltyRows) {
        for (var lr = 0; lr < loyaltyRows.length; lr++) {
          loyaltyMap[loyaltyRows[lr].customer_id] = loyaltyRows[lr];
        }
      }
    }
  }

  // Create the batch record (column names per migration 005)
  var batchRecord = {
    name: name,
    message_template: messageTemplate,
    segment: segment,
    status: 'draft',
    total_recipients: customers.length,
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

  // Create individual message records (message_text per 005; customer_name added in 006)
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
      message_text: resolvedMessage,
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

  var page = parseInt(body.page, 10) || 1;
  var perPage = parseInt(body.per_page, 10) || 50;
  if (page < 1) page = 1;
  if (perPage < 1 || perPage > 200) perPage = 50;
  var offset = (page - 1) * perPage;

  var messages = await supabaseRequest(
    'outbox_messages?batch_id=eq.' + encodeURIComponent(batchId) +
    '&select=*&order=created_at.asc&limit=' + perPage + '&offset=' + offset, 'GET'
  );

  var totalMessages = await countRows(
    'outbox_messages?batch_id=eq.' + encodeURIComponent(batchId) + '&select=id'
  );

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

// --- SEND BATCH (chunked + atomic claims) ---
// Each invocation:
//   1. Atomically claims the batch (draft/paused/sending -> sending).
//   2. Processes at most CHUNK_SIZE queued messages, each atomically claimed
//      (queued -> sending) so parallel invocations never double-send.
//   3. Returns { status: 'in_progress', remaining } if more remain;
//      callers re-invoke send_batch until { status: 'completed' }.
async function sendBatch(body) {
  var batchId = body.batch_id;
  if (!batchId) return { status: 400, body: { error: 'Missing batch_id' } };

  if (!WA_TOKEN || !WA_PHONE_ID) {
    return { status: 500, body: { error: 'WhatsApp not configured' } };
  }

  // Get batch (for existence check + counters)
  var batches = await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId) + '&select=*', 'GET'
  );
  if (!batches || batches.length === 0) {
    return { status: 404, body: { error: 'Batch not found' } };
  }
  var batch = batches[0];

  // Atomically claim the batch: only draft/paused/sending may transition to sending
  var claimPatch = { status: 'sending' };
  if (!batch.started_at) claimPatch.started_at = new Date().toISOString();
  var claimed = await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId) + '&status=in.(draft,paused,sending)',
    'PATCH', claimPatch
  );
  if (!claimed || claimed.length === 0) {
    return { status: 409, body: { error: 'Batch status is ' + batch.status + ', cannot send (only draft, paused, or sending batches)' } };
  }

  var sentCount = batch.sent_count || 0;
  var failedCount = batch.failed_count || 0;
  var chunkSent = 0;
  var chunkFailed = 0;

  // Fetch the next chunk of queued messages
  var messages = await supabaseRequest(
    'outbox_messages?batch_id=eq.' + encodeURIComponent(batchId) +
    '&status=eq.queued&select=*&order=created_at.asc&limit=' + CHUNK_SIZE, 'GET'
  );

  if (messages && messages.length > 0) {
    console.log('Sending chunk for batch:', batchId, 'messages:', messages.length);

    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];

      // Atomically claim this message (queued -> sending). If another
      // invocation already claimed it, zero rows return and we skip.
      var msgClaim = await supabaseRequest(
        'outbox_messages?id=eq.' + encodeURIComponent(msg.id) + '&status=eq.queued',
        'PATCH', { status: 'sending' }
      );
      if (!msgClaim || msgClaim.length === 0) {
        continue;
      }

      // Re-check opt-out right before sending
      var optRows = await supabaseRequest(
        'customers?id=eq.' + encodeURIComponent(msg.customer_id) + '&select=opted_out', 'GET'
      );
      if (optRows && optRows[0] && optRows[0].opted_out) {
        await supabaseRequest(
          'outbox_messages?id=eq.' + encodeURIComponent(msg.id), 'PATCH',
          { status: 'cancelled', error_detail: 'Customer opted out before send' }
        );
        continue;
      }

      var cleanPhone = (msg.phone || '').replace(/\s/g, '');

      try {
        var result = await sendWhatsAppMessage(cleanPhone, msg.message_text);

        if (result.ok) {
          sentCount++;
          chunkSent++;
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
          chunkFailed++;
          var errorDetail = result.error ? JSON.stringify(result.error).slice(0, 500) : 'Unknown error';
          await supabaseRequest(
            'outbox_messages?id=eq.' + encodeURIComponent(msg.id), 'PATCH',
            {
              status: 'failed',
              error_detail: errorDetail,
              sent_at: new Date().toISOString()
            }
          );
        }
      } catch (sendErr) {
        failedCount++;
        chunkFailed++;
        console.error('Send error for message', msg.id, ':', sendErr.message);
        await supabaseRequest(
          'outbox_messages?id=eq.' + encodeURIComponent(msg.id), 'PATCH',
          {
            status: 'failed',
            error_detail: String(sendErr.message || sendErr).slice(0, 500),
            sent_at: new Date().toISOString()
          }
        );
      }

      // Rate limit between sends
      if (i < messages.length - 1) {
        await delay(SEND_DELAY_MS);
      }
    }

    // Update batch counters after the chunk
    await supabaseRequest(
      'outbox_batches?id=eq.' + encodeURIComponent(batchId), 'PATCH',
      { sent_count: sentCount, failed_count: failedCount }
    );
  }

  // How many queued messages remain?
  var remaining = await countRows(
    'outbox_messages?batch_id=eq.' + encodeURIComponent(batchId) + '&status=eq.queued&select=id'
  );

  if (remaining > 0) {
    return {
      status: 200,
      body: {
        batch_id: batchId,
        status: 'in_progress',
        sent: sentCount,
        failed: failedCount,
        chunk_sent: chunkSent,
        chunk_failed: chunkFailed,
        remaining: remaining
      }
    };
  }

  // Done — mark completed (only if still 'sending', so a pause/cancel
  // issued meanwhile is not overwritten)
  await supabaseRequest(
    'outbox_batches?id=eq.' + encodeURIComponent(batchId) + '&status=eq.sending', 'PATCH',
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
      failed: failedCount,
      remaining: 0
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

  // Mark only the remaining QUEUED messages as cancelled
  // ('cancelled' is a valid outbox_messages status as of migration 006)
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
  var statuses = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled'];
  var counts = {};
  var total = 0;
  for (var si = 0; si < statuses.length; si++) {
    var s = statuses[si];
    counts[s] = await countRows(
      'outbox_messages?batch_id=eq.' + encodeURIComponent(batchId) + '&status=eq.' + s + '&select=id'
    );
    total += counts[s];
  }

  return {
    status: 200,
    body: {
      batch: batches[0],
      stats: counts,
      total: total
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
    var listResult = await listBatches();
    return res.status(listResult.status).json(listResult.body);
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
