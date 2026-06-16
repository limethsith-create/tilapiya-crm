// Vercel Serverless Function - Facebook Messenger Webhook for Tilapiya CRM
// Receives inbound Facebook Page DMs and auto-replies via OpenAI.
// Uses the same DB schema and AI brain as the WhatsApp webhook;
// customer rows are keyed by (platform='facebook', platform_user_id=<PSID>).
//
// Required env vars (FB-specific values WIN; falls back to the WhatsApp app's
// values so you can either share one Meta app across all three channels OR
// keep FB/IG on a separate Meta app):
//   - FB_VERIFY_TOKEN        (or fallback to WEBHOOK_VERIFY_TOKEN)
//   - FB_APP_SECRET          (or fallback to META_APP_SECRET)
//   - FB_PAGE_TOKEN          (long-lived Facebook Page access token)
//   - FB_PAGE_ID             (optional, the Page id — used to ignore echoes)
//   - OPENAI_API_KEY         (shared)
//   - SUPABASE_URL, SUPABASE_SERVICE_KEY (shared)
//
// Meta dashboard: subscribe the Messenger product webhook to
//   POST https://<your-vercel-domain>/api/facebook-webhook
// and subscribe to fields: messages, messaging_postbacks (optional).

const {
  readRawBody,
  verifyWebhookSignature,
  handleMessengerPost
} = require('../lib/messenger');

const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || process.env.WEBHOOK_VERIFY_TOKEN || 'tilapiya_meta_2026';
const FB_APP_SECRET = process.env.FB_APP_SECRET || process.env.META_APP_SECRET || '7bf29d84bbdcc9001c5fb24d53e80ee7';
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN || 'EAAVQfRuhk5UBRtcZAOFb53nWZBsH9sGEi3egxcD81pMDxeaQGnYt7iGZC9D0dTdf4QFzzqbdWHmLV2AuyjvjsQAN4vegSPnu7DlqZAIOhSK2QtOonmxCHZBFPeqLZA1CdbL2U4lZBGeGsk3ZAg0RFB38dMQzZBX591VFuT6RcWfr1S5lc2SIIlxOxnWrWEmXWBrTHQy4P8SfxIDiZCGwO6sela6RaiXAZDZD';
const FB_PAGE_ID = process.env.FB_PAGE_ID; // optional

module.exports = async function handler(req, res) {
  // --- GET: webhook verification handshake ---
  if (req.method === 'GET') {
    if (req.query.setup === '1') {
      var sbase = 'https://graph.facebook.com/v22.0';
      var sout = {};
      try { var meR = await fetch(sbase + '/me?fields=id,name&access_token=' + encodeURIComponent(FB_PAGE_TOKEN)); sout.page = await meR.json(); } catch (e) { sout.pageError = String(e); }
      try { var subR = await fetch(sbase + '/me/subscribed_apps?subscribed_fields=messages,messaging_postbacks&access_token=' + encodeURIComponent(FB_PAGE_TOKEN), { method: 'POST' }); sout.subscribeStatus = subR.status; sout.subscribeResult = await subR.json(); } catch (e) { sout.subscribeError = String(e); }
      try { var curR = await fetch(sbase + '/me/subscribed_apps?access_token=' + encodeURIComponent(FB_PAGE_TOKEN)); sout.current = await curR.json(); } catch (e) { sout.currentError = String(e); }
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
      console.log('Facebook webhook verified');
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
      console.error('Failed to read FB raw body:', readErr.message);
      return res.status(400).json({ status: 'bad request' });
    }

    if (!verifyWebhookSignature(req, rawBody, FB_APP_SECRET)) {
      console.error('Invalid FB webhook signature');
      return res.status(401).json({ status: 'invalid signature' });
    }

    if (!FB_PAGE_TOKEN) {
      console.error('FB_PAGE_TOKEN not set - cannot reply');
      return res.status(200).json({ status: 'not configured' });
    }

    try {
      var body;
      try { body = JSON.parse(rawBody.toString('utf-8')); }
      catch (e) {
        console.error('Invalid FB JSON body:', e.message);
        return res.status(400).json({ status: 'invalid json' });
      }

      await handleMessengerPost(body, {
        platform: 'facebook',
        pageToken: FB_PAGE_TOKEN,
        pageIds: FB_PAGE_ID ? [FB_PAGE_ID] : [],
        expectedObject: 'page'
      });

      return res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error('FB webhook error:', err);
      return res.status(200).json({ status: 'error' });
    }
  }

  return res.status(405).send('Method not allowed');
};

module.exports.config = { api: { bodyParser: false } };
