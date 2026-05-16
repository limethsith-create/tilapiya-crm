// Vercel Serverless Function - Dashboard Authentication
// Simple password-based auth that returns the dashboard secret key for API calls

const crypto = require('crypto');
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD; // set in Vercel env vars
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET; // the key dashboard uses for API calls
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';

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

  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  // Timing-safe comparison to prevent timing attacks
  const passBuffer = Buffer.from(password);
  const expectedBuffer = Buffer.from(DASHBOARD_PASSWORD);
  if (passBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(passBuffer, expectedBuffer)) {
    return res.status(200).json({
      status: 'authenticated',
      key: DASHBOARD_SECRET,
      expires: Date.now() + (24 * 60 * 60 * 1000) // 24hr validity hint for frontend
    });
  }

  return res.status(401).json({ error: 'Invalid password' });
};
