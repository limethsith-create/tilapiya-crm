// Vercel Serverless Function - Instagram DM Webhook for Tilapiya CRM
// Receives inbound Instagram messages from Meta and auto-replies via OpenAI.
// Uses the same DB schema and AI brain as the WhatsApp webhook;
// customer rows are keyed by (platform='instagram', platform_user_id=<IGSID>).
//
// Required env vars (IG-specific values WIN; falls back to FB, then to the
// WhatsApp app's values, so one Meta app can serve all three channels OR
// you can run IG on a separate app):
//   - IG_VERIFY_TOKEN        (or fallback to FB_VERIFY_TOKEN, then WEBHOOK_VERIFY_TOKEN)
//   - IG_APP_SECRET          (or fallback to FB_APP_SECRET, then META_APP_SECRET)
//   - IG_PAGE_TOKEN          (long-lived page access token for the IG-linked FB page)
//   - IG_PAGE_ID             (optional, the IG business account id — used to ignore echoes)
//   - OPENAI_API_KEY         (shared)
//   - SUPABASE_URL, SUPABASE_SERVICE_KEY (shared)
//
// Meta dashboard: subscribe the Instagram product webhook to
//   POST https://<your-vercel-domain>/api/instagram-webhook
// and subscribe to fields: messages, messaging_postbacks (optional).

const {
  readRawBody,
  verifyWebhookSignature,
  handleMessengerPost
} = require('../lib/messenger');

const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || process.env.FB_VERIFY_TOKEN || process.env.WEBHOOK_VERIFY_TOKEN || 'tilapiya_meta_2026';
const IG_APP_SECRET = process.env.IG_APP_SECRET || process.env.FB_APP_SECRET || process.env.META_APP_SECRET || 'cfa507befc2038d69f0c8e72a66e2bae';
const IG_PAGE_TOKEN = process.env.IG_PAGE_TOKEN || 'IGAAWEtLoAjLlBZAGFoOFcxSEFVZAnVCVUc2a3B3UmNHQVJHSHE4S1NocF9td1g3U2FrX3lsTlNycTZAjZA2owMVJXa0xnOGxPbHNsTDBTLVJ3cm9ZASy01M1dTR1N0YkxRZAV9rc0ZA5dHBxWFYzVHpoSVUxc3FSS1IwLUM0cGhMcjFJZAwZDZD';
const IG_PAGE_ID = process.env.IG_PAGE_ID; // optional

module.exports = async function handler(req, res) {
  // --- GET: webhook verification handshake ---
  if (req.method === 'GET') {
    // One-time setup helper: /api/instagram-webhook?setup=1 subscribes this
    // Instagram account to the 'messages' webhook so Meta delivers DMs.
    if (req.query.setup === '1') {
      var sbase = 'https://graph.instagram.com/v22.0';
      var sout = {};
      try { var meR = await fetch(sbase + '/me?fields=user_id,username&access_token=' + encodeURIComponent(IG_PAGE_TOKEN)); sout.account = await meR.json(); } catch (e) { sout.accountError = String(e); }
      try { var subR = await fetch(sbase + '/me/subscribed_apps?subscribed_fields=messages&access_token=' + encodeURIComponent(IG_PAGE_TOKEN), { method: 'POST' }); sout.subscribeStatus = subR.status; sout.subscribeResult = await subR.json(); } catch (e) { sout.subscribeError = String(e); }
      try { var curR = await fetch(sbase + '/me/subscribed_apps?access_token=' + encodeURIComponent(IG_PAGE_TOKEN)); sout.current = await curR.json(); } catch (e) { sout.currentError = String(e); }
      return res.status(200).json(sout);
    }
    if (!VERIFY_TOKEN) {
      console.error('WEBHOOK_VERIFY_TOKEN not set');
      return res.status(500).send('Server misconfigured');
    }
    var mode = req.query['hub.mode'];
    var token = req.query['hub.verify_token'];
    var challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && (token === VERIFY_TOKEN || token === 'tilapiya_meta_2026')) {
      console.log('Instagram webhook verified');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // --- POST: incoming message events ---
  if (req.method === 'POST') {
    var rawBody;
    try {
      rawBody = await readRawBody(req);
    } catch (readErr) {
      console.error('Failed to read IG raw body:', readErr.message);
      return res.status(400).json({ status: 'bad request' });
    }

    if (!verifyWebhookSignature(req, rawBody, IG_APP_SECRET)) {
      console.error('Invalid IG webhook signature');
      return res.status(401).json({ status: 'invalid signature' });
    }

    if (!IG_PAGE_TOKEN) {
      console.error('IG_PAGE_TOKEN not set - cannot reply');
      // Still 200 so Meta does not retry forever; we just skip processing.
      return res.status(200).json({ status: 'not configured' });
    }

    try {
      var body;
      try { body = JSON.parse(rawBody.toString('utf-8')); }
      catch (e) {
        console.error('Invalid IG JSON body:', e.message);
        return res.status(400).json({ status: 'invalid json' });
      }

      await handleMessengerPost(body, {
        platform: 'instagram',
        pageToken: IG_PAGE_TOKEN,
        pageIds: IG_PAGE_ID ? [IG_PAGE_ID] : [],
        expectedObject: 'instagram'
      });

      return res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error('IG webhook error:', err);
      // 200 so Meta doesn't retry the same broken payload forever
      return res.status(200).json({ status: 'error' });
    }
  }

  return res.status(405).send('Method not allowed');
};

module.exports.config = { api: { bodyParser: false } };
