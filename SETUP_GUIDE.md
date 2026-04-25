# WhatsApp + CRM Restaurant Automation — Setup Guide

## What You're Setting Up

A fully automated restaurant system that handles WhatsApp customer messages with AI, manages bookings, sends reminders, collects payments, and runs CRM campaigns — all with minimal human involvement.

**System Components:**
- **Supabase** — Database (customers, bookings, conversations, payments, campaigns)
- **n8n** — Workflow automation engine (4 workflows)
- **WhatsApp Business Cloud API** — Customer messaging channel
- **OpenAI API** — AI-powered replies and intent detection
- **Dashboard** — Staff web interface (hosted as a static HTML file)

---

## Step 1: Supabase Setup (10 minutes)

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project (name it after the restaurant, e.g. "tilapiya-crm")
3. Wait for the project to initialize (~2 minutes)
4. Go to **SQL Editor** in the left sidebar
5. Copy the entire contents of `supabase_schema.sql` and paste it in
6. Click **Run** — this creates all 7 tables, indexes, and security policies
7. Go to **Settings → API** and copy these two values:
   - **Project URL** (e.g. `https://xxxx.supabase.co`)
   - **service_role key** (the secret one, NOT the anon key)
   - **anon/public key** (for the dashboard)

**Save these — you'll need them for n8n and the dashboard.**

---

## Step 2: WhatsApp Business API (20 minutes)

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Create a new app → Select **Business** type
3. Add the **WhatsApp** product to your app
4. In WhatsApp → Getting Started:
   - You'll get a **temporary test phone number** and a **Phone Number ID**
   - You'll get a **temporary access token** (for testing — generate a permanent one later)
5. Add your test phone number as a recipient in the sandbox
6. **Set up the webhook:**
   - Callback URL: `https://YOUR-N8N-URL/webhook/whatsapp`
   - Verify token: any string you choose (e.g. `tilapiya_verify_2026`)
   - Subscribe to: `messages`
7. For production: Apply for WhatsApp Business API access and get a permanent token

**Values to save:**
- `META_PHONE_NUMBER_ID` — your WhatsApp phone number ID
- `META_WHATSAPP_TOKEN` — your access token

---

## Step 3: OpenAI API Key (5 minutes)

1. Go to [platform.openai.com](https://platform.openai.com)
2. Create an account and add billing ($5 minimum)
3. Go to API Keys → Create new key
4. Copy the key (starts with `sk-...`)
5. The system uses `gpt-4o-mini` which costs ~$0.15 per 1M input tokens — very cheap

**Value to save:** `OPENAI_API_KEY`

---

## Step 4: n8n Setup (15 minutes)

### Option A: n8n Cloud (Easiest)
1. Go to [n8n.io](https://n8n.io) and sign up for free trial
2. You get a hosted instance at `https://yourname.app.n8n.cloud`

### Option B: Self-hosted (Free forever)
```bash
# Using Docker
docker run -d --name n8n \
  -p 5678:5678 \
  -v n8n_data:/home/node/.n8n \
  n8nio/n8n
```

### Import Workflows

1. In n8n, go to **Settings → Environment Variables** and add:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_KEY=eyJhbGci...your-service-role-key
   META_PHONE_NUMBER_ID=your-phone-number-id
   META_WHATSAPP_TOKEN=your-whatsapp-token
   OPENAI_API_KEY=sk-your-openai-key
   ```

2. Import each workflow:
   - Go to **Workflows → Import from File**
   - Import `phase1_whatsapp_handler.json` — the core message handler
   - Import `phase2_reminders.json` — payment & booking reminders
   - Import `phase3_post_visit.json` — review requests & customer segmentation
   - Import `phase4_crm_campaigns.json` — CRM campaign sender

3. **Activate** each workflow (toggle the switch in the top right)

4. Copy your webhook URL — it will look like:
   `https://yourname.app.n8n.cloud/webhook/whatsapp`

5. Paste this URL into your WhatsApp webhook settings (Step 2)

---

## Step 5: Dashboard Setup (5 minutes)

1. Open `dashboard/index.html` in a text editor
2. Find these lines near the top of the `<script>` section:
   ```javascript
   const SUPABASE_URL  = 'YOUR_SUPABASE_URL';
   const SUPABASE_ANON = 'YOUR_SUPABASE_ANON_KEY';
   ```
3. Replace with your real Supabase values:
   ```javascript
   const SUPABASE_URL  = 'https://xxxx.supabase.co';
   const SUPABASE_ANON = 'eyJhbGci...your-anon-key';
   ```
4. **Hosting options:**
   - **Netlify** (free): Drag and drop the `dashboard` folder to [netlify.com/drop](https://app.netlify.com/drop)
   - **Vercel** (free): Deploy via CLI or GitHub
   - **Local**: Just open the HTML file in a browser

5. Default login password: `admin123` — **change it** by:
   - Go to [emn178.github.io/online-tools/sha256.html](https://emn178.github.io/online-tools/sha256.html)
   - Type your new password, copy the hash
   - Replace the `PW_HASH` value in the HTML file

---

## Step 6: Customize for the Restaurant

In `phase1_whatsapp_handler.json`, find the AI system prompt inside the "AI Intent Detection" node. Update these details:

```
- Restaurant name
- Opening hours
- Location / address
- Cuisine type
- Parking info
- Special diet options
- Any house rules or policies
```

In `phase3_post_visit.json`, update the review link placeholder to point to the restaurant's actual Google or TripAdvisor review page.

---

## Step 7: Test Everything

1. Send a WhatsApp message to the test number: "Hi, I'd like to book a table for 4 on Saturday at 7pm"
2. The AI should reply within 5-10 seconds with a booking confirmation
3. Check the dashboard — you should see:
   - The customer in Contacts
   - The booking in Daily Log
   - The conversation in Inbox
4. Test other intents: ask about hours, make a complaint, ask about the menu
5. Run a test CRM campaign from the dashboard

---

## Monthly Costs (Approximate)

| Service | Free Tier | After Free Tier |
|---------|-----------|-----------------|
| Supabase | 500MB, 50K rows | $25/mo |
| n8n Cloud | 2,500 executions | $20/mo |
| WhatsApp API | 1,000 free conversations/mo | ~$0.05/conversation |
| OpenAI (gpt-4o-mini) | — | ~$5-15/mo for typical restaurant |
| Dashboard hosting (Netlify) | Free | Free |
| **Total** | **~$0/mo to start** | **~$50-60/mo** |

---

## Selling This to a Restaurant

### Pricing Suggestion
- **Setup fee:** $500-1,500 (one-time, covers customization + onboarding)
- **Monthly fee:** $150-300/month (covers hosting + your support + margins on API costs)
- **Value pitch:** "This replaces a full-time receptionist for WhatsApp bookings, runs 24/7, never forgets a follow-up, and builds your customer database automatically."

### Key Demo Points
1. Send a live WhatsApp message → show instant AI reply
2. Show the booking appearing in the dashboard in real time
3. Show the CRM segments (VIP, lapsed, first-timer)
4. Show the automated review request flow
5. Show campaign creation → messages going out to segments

### What the Restaurant Gets
- 24/7 WhatsApp AI assistant (handles bookings, inquiries, complaints)
- Complete booking management dashboard
- Automated reminders (payment + 24hr before visit)
- Post-visit review collection
- CRM with customer segmentation and automated campaigns
- All conversation history stored and searchable
- Phone call logging for staff

---

## File Structure

```
Tilapiya/
├── supabase_schema.sql          — Database schema (run in Supabase SQL Editor)
├── phase1_whatsapp_handler.json — Core: WhatsApp AI message handler
├── phase2_reminders.json        — Automation: Payment + booking reminders
├── phase3_post_visit.json       — Automation: Review requests + segmentation
├── phase4_crm_campaigns.json    — CRM: Campaign message sender
├── dashboard/
│   └── index.html               — Staff dashboard (The Brain)
├── whatsapp_crm_flow_v2.html    — System flowchart (for demos/sales)
└── SETUP_GUIDE.md               — This file
```
