// Shared dashboard auth helpers for Tilapiya CRM API endpoints.
// Token format: "<expiryMillis>.<hexHmacSha256(DASHBOARD_SECRET, expiryMillis)>"
// isAuthorized(req) accepts EITHER a valid unexpired token OR the raw
// DASHBOARD_SECRET (back-compat). Fails closed if DASHBOARD_SECRET is unset.

const crypto = require('crypto');

const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function hmacHex(value) {
  return crypto.createHmac('sha256', DASHBOARD_SECRET).update(String(value)).digest('hex');
}

// Hash both sides before timingSafeEqual so lengths always match
// (no length pre-check leak).
function safeEqual(a, b) {
  try {
    var ha = crypto.createHash('sha256').update(String(a)).digest();
    var hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  } catch (e) {
    return false;
  }
}

// Issue a new dashboard token, valid for 24 hours.
function issueToken() {
  if (!DASHBOARD_SECRET) {
    throw new Error('DASHBOARD_SECRET not set');
  }
  var exp = Date.now() + TOKEN_TTL_MS;
  return exp + '.' + hmacHex(exp);
}

// Validate the X-Dashboard-Key header. Accepts a signed token or the raw secret.
function isAuthorized(req) {
  if (!DASHBOARD_SECRET) {
    console.error('[auth] DASHBOARD_SECRET not set - failing closed');
    return false;
  }
  var key = (req && req.headers && req.headers['x-dashboard-key']) || '';
  if (typeof key !== 'string' || key.length === 0) return false;

  // Token form: "<exp>.<hexsig>"
  var dot = key.indexOf('.');
  if (dot > 0) {
    var expStr = key.slice(0, dot);
    var sig = key.slice(dot + 1);
    var exp = parseInt(expStr, 10);
    if (isFinite(exp) && exp > Date.now() && safeEqual(sig, hmacHex(expStr))) {
      return true;
    }
  }

  // Back-compat: raw DASHBOARD_SECRET
  return safeEqual(key, DASHBOARD_SECRET);
}

module.exports = { isAuthorized, issueToken };
