// Shared Supabase PostgREST helper for Tilapiya CRM API endpoints.
// Uses the service-role key, 15s timeout on every request, returns parsed
// JSON or null on error (status + body are logged).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabaseRequest(path, method, body, extraHeaders) {
  var headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
  if (method === 'POST' || method === 'PATCH') headers['Prefer'] = 'return=representation';
  if (extraHeaders) {
    for (var k in extraHeaders) headers[k] = extraHeaders[k];
  }
  try {
    var r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) {
      var err = await r.text();
      console.error('Supabase error:', method, path, r.status, err);
      return null;
    }
    var text = await r.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) { return null; }
  } catch (fetchErr) {
    console.error('Supabase request failed:', method, path, fetchErr.message);
    return null;
  }
}

module.exports = { supabaseRequest, SUPABASE_URL, SUPABASE_KEY };
