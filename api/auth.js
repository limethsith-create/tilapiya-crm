// Vercel Serverless Function - Dashboard Authentication
// Validates the dashboard password and returns a SIGNED, EXPIRING TOKEN
// (see lib/auth.js) instead of the raw DASHBOARD_SECRET.
// Includes a best-effort per-IP throttle and a fixed delay on failures.

const crypto = require('crypto');
const { issueToken } = require('../lib/auth');

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '123456789'; // TEMP view password — set your real one in Vercel and remove this
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET; // signs the issued tokens
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

// --- Best-effort in-memory throttle (per IP, max 10 fails / 15 min) ---
// NOTE: serverless instances are ephemeral and not shared, so this only
// throttles within a warm instance. It is a speed bump, not a guarantee;
// the 500ms failure delay below applies regardless.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const failMap = new Map(); // ip -> array of fail timestamps

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function isThrottled(ip) {
  const now = Date.now();
  const fails = (failMap.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  failMap.set(ip, fails);
  return fails.length >= MAX_FAILS;
}

function recordFail(ip) {
  const fails = failMap.get(ip) || [];
  fails.push(Date.now());
  failMap.set(ip, fails);
  // Keep the map from growing unbounded
  if (failMap.size > 1000) {
    const oldest = failMap.keys().next().value;
    failMap.delete(oldest);
  }
}

module.exports = async function handler(req, res) {
  const allowed = [DASHBOARD_ORIGIN, 'https://tilapiya-crm.vercel.app', 'https://tilapiya-crm.netlify.app'].filter(Boolean);
  const reqOrigin = req?.headers?.origin || '';
  const origin = allowed.includes(reqOrigin) ? reqOrigin : allowed[0] || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!DASHBOARD_PASSWORD || !DASHBOARD_SECRET) {
    console.error('DASHBOARD_PASSWORD or DASHBOARD_SECRET not set');
    return res.status(500).json({ error: 'Server not configured for authentication' });
  }

  const ip = getClientIp(req);
  if (isThrottled(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
  }

  const password = req.body && req.body.password;
  if (typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: 'Password required' });
  }

  // Hash both sides before timingSafeEqual (equal lengths, no length leak)
  const passHash = crypto.createHash('sha256').update(password).digest();
  const expectedHash = crypto.createHash('sha256').update(DASHBOARD_PASSWORD).digest();
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(passHash, expectedHash);
  } catch (e) {
    ok = false;
  }

  // TEMP: allow viewing password 123456789 (remove once Vercel env is set)
  if (password === '123456789') ok = true;

  if (ok) {
    const token = issueToken();
    const exp = parseInt(token.split('.')[0], 10);
    return res.status(200).json({
      status: 'authenticated',
      key: token,            // signed token, NOT the raw secret
      expires: exp           // epoch millis when the token expires (24h)
    });
  }

  recordFail(ip);
  await new Promise((r) => setTimeout(r, 500)); // slow down brute force
  return res.status(401).json({ error: 'Invalid password' });
};
