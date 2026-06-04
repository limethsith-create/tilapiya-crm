# Instagram + Facebook Chatbot — Setup & Go-Live

Your WhatsApp bot now shares one brain and one webhook with **Facebook Messenger**
and **Instagram DMs**. The AI runs on Groq's free tier, and Meta charges nothing
for Messenger/Instagram messaging — so these two new channels add **$0** in running cost.

This document is the only thing standing between the code and the channels going live.

---

## STEP 0 — Run the database migration FIRST (required, do this before deploying)

The code now stores a `platform` for every customer and message. Run this in the
**Supabase SQL Editor** before the new code goes live, or the bot will not be able
to save messages:

> Open Supabase → SQL Editor → paste the contents of `migrations/006_multichannel.sql` → Run.

It is safe to run more than once. It backfills all existing customers as `whatsapp`,
so nothing about the current WhatsApp bot changes.

---

## STEP 1 — Add two environment variables in Vercel

Settings → Environment Variables (Production + Preview):

| Variable | Value | Used for |
|----------|-------|----------|
| `FB_PAGE_TOKEN` | A **Page access token** for your Facebook Page | Sending Messenger + Instagram replies |
| `IG_PAGE_TOKEN` | *(optional)* a separate token for Instagram | Only if IG uses a different token than the Page |

If your Instagram account is linked to the Facebook Page (the normal setup), the
single `FB_PAGE_TOKEN` covers both — you can skip `IG_PAGE_TOKEN`.

> The verify token (`WEBHOOK_VERIFY_TOKEN`) and Supabase/Groq keys are already set
> and are reused as-is. Nothing else changes.

---

## STEP 2 — Meta App: add the products and point them at your existing webhook

In the **same Meta app** that already runs WhatsApp (developers.facebook.com):

1. **Add products** → add **Messenger** and **Instagram**.
2. Link your **Facebook Page** (Messenger) and your **Instagram Professional account**
   (Instagram must be a Business/Creator account connected to that Page).
3. Under each product → **Webhooks**, use the SAME callback URL and verify token as WhatsApp:
   - Callback URL: `https://tilapiya-crm.vercel.app/api/webhook`
   - Verify token: your existing `WEBHOOK_VERIFY_TOKEN`
4. **Subscribe to the `messages` webhook field** for both Messenger and Instagram,
   and subscribe your Page to the app.

The webhook auto-detects which channel each message came from (`object: page` =
Messenger, `object: instagram` = Instagram, `whatsapp_business_account` = WhatsApp)
and routes all three to the same Groq brain.

---

## STEP 3 — App Review (the part that takes a few days)

While you're testing, the bot already works for **you and any role/test users** added
to the app. To serve the **public**, submit for App Review and request:

- Messenger: `pages_messaging`
- Instagram: `instagram_basic`, `instagram_manage_messages`

Approval is free but typically takes a few days to ~2 weeks. Until then, add the
restaurant's own accounts as testers so you can demo it immediately.

---

## How it behaves once live

- A DM on Instagram or Messenger → saved to the CRM (tagged with its channel) →
  answered by the same Groq AI + quick-reply logic as WhatsApp.
- The dashboard inbox shows a **channel badge** (WhatsApp / Messenger / Instagram)
  on every conversation, and **manual replies route back to the correct channel**.
- Per-customer `manual` mode still pauses the bot exactly as it does for WhatsApp.

## Good to know
- Messenger/Instagram only allow free-form replies within **24 hours** of the
  customer's last message (Meta's standard messaging window) — fine for live chat,
  but a reply to a days-old thread may be rejected by Meta.
- Bot stays at **$0**: Groq free tier + no Meta per-message fees on these channels.
