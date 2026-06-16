// Vercel Serverless Function - Authenticated data proxy for the dashboard.
// Replaces direct anon-key Supabase reads from the frontend.
//
// POST only. Auth: X-Dashboard-Key (token or raw secret, see lib/auth.js).
// Body: { table, action, select?, filters?, values?, order?, limit?, count?, onConflict? }
//   action: "select" | "insert" | "update" (update requires non-empty filters)
// Response: { data: [...], count? } or { error: "..." }

const { isAuthorized } = require('../lib/auth');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

// NOTE: 'loyalty_rewards' from the contract is omitted because no such table
// exists in the schema (the actual table is 'rewards', whitelisted below).
const TABLE_WHITELIST = [
  'customers', 'conversations', 'bookings', 'feedback', 'loyalty',
  'payments', 'crm_campaigns', 'visits', 'rewards',
  'outbox_batches', 'outbox_messages'
];

const OP_WHITELIST = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'ilike', 'is'];
const COLUMN_RE = /^[a-z_][a-z0-9_]*$/;

function setCorsHeaders(res, req) {
  var allowed = [DASHBOARD_ORIGIN, 'https://tilapiya-crm.vercel.app', 'https://tilapiya-crm.netlify.app'].filter(Boolean);
  var reqOrigin = req && req.headers ? req.headers.origin || '' : '';
  var origin = allowed.includes(reqOrigin) ? reqOrigin : (allowed[0] || '*');
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Dashboard-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// Build "&col=op.value" query fragments from the filters array.
// Returns { error } or { query }.
function buildFilterQuery(filters) {
  var parts = [];
  for (var i = 0; i < filters.length; i++) {
    var f = filters[i] || {};
    if (typeof f.column !== 'string' || !COLUMN_RE.test(f.column)) {
      return { error: 'Invalid filter column: ' + String(f.column) };
    }
    if (OP_WHITELIST.indexOf(f.op) === -1) {
      return { error: 'Invalid filter op: ' + String(f.op) };
    }
    if (f.op === 'in') {
      if (!Array.isArray(f.value)) {
        return { error: 'Filter op "in" requires an array value' };
      }
      var encoded = f.value.map(function (v) { return encodeURIComponent(String(v)); });
      parts.push(f.column + '=in.(' + encoded.join(',') + ')');
    } else {
      parts.push(f.column + '=' + f.op + '.' + encodeURIComponent(String(f.value)));
    }
  }
  return { query: parts.length ? '&' + parts.join('&') : '' };
}

function validateSelect(select) {
  if (select === undefined || select === null) return '*';
  if (typeof select !== 'string' || select.length > 1000) return null;
  // Allow column lists and embedded resources, e.g. "id,name,customers(name,phone)"
  if (!/^[a-zA-Z0-9_,():*.\- ]+$/.test(select)) return null;
  return select;
}

async function supabaseFetch(path, method, body, extraHeaders) {
  var headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
  if (extraHeaders) {
    for (var k in extraHeaders) headers[k] = extraHeaders[k];
  }
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: method,
    headers: headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
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

  var table = body.table;
  var action = body.action;

  if (TABLE_WHITELIST.indexOf(table) === -1) {
    return res.status(400).json({ error: 'Table not allowed: ' + String(table) });
  }
  if (action !== 'select' && action !== 'insert' && action !== 'update') {
    return res.status(400).json({ error: 'Invalid action. Use select, insert, or update.' });
  }

  var filters = Array.isArray(body.filters) ? body.filters : [];
  var filterResult = buildFilterQuery(filters);
  if (filterResult.error) {
    return res.status(400).json({ error: filterResult.error });
  }
  var filterQuery = filterResult.query;

  try {
    // ---------- SELECT ----------
    if (action === 'select') {
      var select = validateSelect(body.select);
      if (select === null) return res.status(400).json({ error: 'Invalid select string' });

      var limit = 100;
      if (body.limit !== undefined) {
        limit = parseInt(body.limit, 10);
        if (!isFinite(limit) || limit < 1) return res.status(400).json({ error: 'Invalid limit' });
        if (limit > 1000) limit = 1000;
      }

      var orderQuery = '';
      if (body.order) {
        var oc = body.order.column;
        if (typeof oc !== 'string' || !COLUMN_RE.test(oc)) {
          return res.status(400).json({ error: 'Invalid order column' });
        }
        orderQuery = '&order=' + oc + '.' + (body.order.ascending ? 'asc' : 'desc');
      }

      var path = table + '?select=' + encodeURIComponent(select) + filterQuery + orderQuery + '&limit=' + limit;
      var extraHeaders = body.count === true ? { 'Prefer': 'count=exact' } : undefined;

      var r = await supabaseFetch(path, 'GET', undefined, extraHeaders);
      var text = await r.text();
      if (!r.ok) {
        console.error('[data] select error:', table, r.status, text);
        return res.status(502).json({ error: 'Database query failed (' + r.status + ')' });
      }
      var rows;
      try { rows = JSON.parse(text); } catch (e) { rows = []; }

      var out = { data: rows };
      if (body.count === true) {
        var contentRange = r.headers.get('content-range') || '';
        var m = contentRange.match(/\/(\d+)/);
        if (m) out.count = parseInt(m[1], 10);
      }
      return res.status(200).json(out);
    }

    // ---------- INSERT ----------
    if (action === 'insert') {
      var values = body.values;
      if (!values || (typeof values !== 'object')) {
        return res.status(400).json({ error: 'Missing values for insert' });
      }
      var insertPath = table;
      var prefer = 'return=representation';
      if (body.onConflict !== undefined) {
        if (typeof body.onConflict !== 'string' || !COLUMN_RE.test(body.onConflict)) {
          return res.status(400).json({ error: 'Invalid onConflict column' });
        }
        insertPath += '?on_conflict=' + body.onConflict;
        prefer = 'resolution=merge-duplicates,return=representation';
      }
      var ri = await supabaseFetch(insertPath, 'POST', values, { 'Prefer': prefer });
      var ti = await ri.text();
      if (!ri.ok) {
        console.error('[data] insert error:', table, ri.status, ti);
        return res.status(502).json({ error: 'Insert failed (' + ri.status + ')' });
      }
      var inserted;
      try { inserted = JSON.parse(ti); } catch (e) { inserted = []; }
      return res.status(200).json({ data: inserted });
    }

    // ---------- UPDATE ----------
    if (action === 'update') {
      if (filters.length === 0) {
        return res.status(400).json({ error: 'Update requires non-empty filters' });
      }
      var updateValues = body.values;
      if (!updateValues || typeof updateValues !== 'object' || Array.isArray(updateValues)) {
        return res.status(400).json({ error: 'Missing values object for update' });
      }
      var ru = await supabaseFetch(table + '?' + filterQuery.slice(1), 'PATCH', updateValues, { 'Prefer': 'return=representation' });
      var tu = await ru.text();
      if (!ru.ok) {
        console.error('[data] update error:', table, ru.status, tu);
        return res.status(502).json({ error: 'Update failed (' + ru.status + ')' });
      }
      var updated;
      try { updated = JSON.parse(tu); } catch (e) { updated = []; }
      return res.status(200).json({ data: updated });
    }
  } catch (err) {
    console.error('[data] handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
