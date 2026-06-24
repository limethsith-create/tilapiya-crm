# Tilapiya CRM — WhatsApp Web Bridge

This connects your **WhatsApp** to your **Tilapiya CRM**. When a customer
messages your restaurant number, the bridge sends the message to the CRM brain,
the brain replies, the reply goes back to the customer, and the **whole
conversation is saved in your Tilapiya dashboard**.

Once set up it runs **24/7 on its own** — no Meta Cloud API, no app review,
no tokens. Just link the WhatsApp account once.

---

## How it fits together

```
Customer's WhatsApp
        │  (message)
        ▼
  WhatsApp Web  ──►  Bridge (this folder, runs on your computer 24/7)
                          │  POST {from, text, name}  +  Bearer secret
                          ▼
   https://tilapiya-crm2.vercel.app/api/wa-bridge
                          │  AI brain (OpenAI) generates reply, saves to Supabase
                          ▼
                   returns { reply }
                          │
  Bridge sends the reply back  ──►  Customer's WhatsApp
```

No Meta Cloud API anywhere in this path.

---

## Part 1 — Brain endpoint (already in the Vercel deploy)

The file `api/wa-bridge.js` is already in this repo. When you deploy the
project to Vercel it goes live at `https://<your-vercel>.vercel.app/api/wa-bridge`.

**Required Vercel env vars:**

| Name | Value |
|------|-------|
| `OPENAI_API_KEY` | your OpenAI key (the brain uses gpt-4o-mini) |
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | the service-role key |
| `BRIDGE_SECRET` *(optional)* | a long random string — must match the bridge's `.env` |

If `BRIDGE_SECRET` is unset, both sides use a baked-in default. Fine for testing,
**rotate it for production**.

Verify the endpoint is up: open
`https://tilapiya-crm2.vercel.app/api/wa-bridge` in a browser. You should
see `{"ok":true,"configured":true,...}`.

---

## Part 2 — Run the bridge on a computer (one time, ~5 min)

Do this on a computer that stays on 24/7 (the laptop at reception, a small
office PC, etc).

### 1. Install Node.js

If `node -v` doesn't print a version ≥ 18, install **LTS** from
<https://nodejs.org>.

### 2. Install bridge dependencies

Open a terminal in this `whatsapp-bridge` folder and run:

```bash
npm install
```

### 3. Configure `.env`

Copy the example file and edit:

```bash
copy .env.example .env       # Windows
# or
cp .env.example .env         # macOS / Linux
```

Open `.env` in Notepad. Fill in:

- `PAIR_NUMBER` — the restaurant's WhatsApp number, **digits only**, country
  code first, no `+`. e.g. for Sri Lanka 077 123 4567 → `94771234567`.
- Leave `BRAIN_URL` and `BRIDGE_SECRET` as the defaults (unless you changed
  them on Vercel).

### 4. Start the bridge

Easiest: double-click **`START-HERE.bat`**. It installs deps if needed and
keeps the bridge running.

Or from a terminal:

```bash
npm start
```

### 5. Link WhatsApp

Within ~10 seconds the terminal prints an 8-character pairing code like:

```
##############################################
#   TILAPIYA WHATSAPP LINK CODE:   ABCD-1234
##############################################
```

On the phone that holds `PAIR_NUMBER`:

1. Open **WhatsApp** → **Settings** → **Linked Devices**.
2. **Link a device** → **"Link with phone number instead"**.
3. Type the 8-character code (no dash).

When the terminal prints `[tilapiya-bridge] CONNECTED. Listening for messages...`,
you're live. Test by messaging the restaurant number from another phone.

---

## Part 3 — Keep it running 24/7 (recommended)

The `START-HERE.bat` script already auto-restarts the bridge after crashes,
and adds itself to Windows Startup so it relaunches after reboot. That covers
most cases.

For more robustness (production), install PM2:

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # follow the printed command to enable on-boot start
```

Then check it with `pm2 logs tilapiya-whatsapp-bridge`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Pairing code says invalid | The number must be linkable from WhatsApp Settings → Linked Devices on a phone with that number installed. Code is good for ~2 min. |
| Bridge connects but no replies | Check `bridge-log.txt`. If you see `brain HTTP 401`, the `BRIDGE_SECRET` in `.env` doesn't match the one on Vercel. If `brain HTTP 500`, check Vercel function logs. |
| "OPENAI_API_KEY not set" in Vercel logs | Add it under Vercel → Settings → Environment Variables, then redeploy. |
| Replies missing in the dashboard | Make sure `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set on Vercel and the Supabase database migrations have all run. |
| Phone shows "Computer not linked" | The bridge died. Restart it (close the window, run `START-HERE.bat` again). Repeat the pairing if needed. |

---

## Security notes

- `BRIDGE_SECRET` is the only thing protecting the brain endpoint. Treat it
  like a password.
- The local `.env` should NEVER be committed to git. It's covered by the
  bridge folder's `.gitignore`.
- The brain endpoint accepts the secret as a Bearer token, compared in
  constant time.
- Customer phone numbers, names, and message text are stored in your own
  Supabase. No third party (besides OpenAI for the reply generation and
  WhatsApp for delivery) sees them.
