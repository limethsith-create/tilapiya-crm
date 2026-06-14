// TEMPORARY one-time helper: subscribes this Instagram account to the
// 'messages' webhook so Meta will start delivering DMs to /api/instagram-webhook.
// Visit  /api/ig-setup?go=1  once in your browser, then you can delete this file.

const IG_PAGE_TOKEN = process.env.IG_PAGE_TOKEN || 'IGAAWEtLoAjLlBZAGI4QkdsRTZAzY0gwYzJGbkE0dl9nSmd0NE5WRUIyM3YtUU1pWW1oUjZAPRkt1NlZAld1R0NVZAValNmdnJpblVWRUVYMlo2ZA0I0d1MtZAWM4V05GVER3MlcwYUVEV21XcmFka0dsM3VFQ0VQOWlpOHNWR3EwLTZAlYwZDZD';

module.exports = async function handler(req, res) {
  if (req.query.go !== '1') {
    return res.status(200).json({ hint: 'Add ?go=1 to the end of the URL to run the Instagram webhook subscription.' });
  }
  const base = 'https://graph.instagram.com/v22.0';
  const out = {};
  try {
    const meR = await fetch(base + '/me?fields=user_id,username&access_token=' + encodeURIComponent(IG_PAGE_TOKEN));
    out.account = await meR.json();
  } catch (e) { out.accountError = String(e); }
  try {
    const subR = await fetch(base + '/me/subscribed_apps?subscribed_fields=messages&access_token=' + encodeURIComponent(IG_PAGE_TOKEN), { method: 'POST' });
    out.subscribeStatus = subR.status;
    out.subscribeResult = await subR.json();
  } catch (e) { out.subscribeError = String(e); }
  try {
    const curR = await fetch(base + '/me/subscribed_apps?access_token=' + encodeURIComponent(IG_PAGE_TOKEN));
    out.currentSubscriptions = await curR.json();
  } catch (e) { out.currentError = String(e); }
  return res.status(200).json(out);
};
