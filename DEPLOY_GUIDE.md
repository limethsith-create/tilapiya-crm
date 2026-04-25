# How to Put Your Dashboard Online (Free) — GitHub + Vercel

This gets your restaurant dashboard live on the internet with a real URL you can share with clients. Total cost: $0.

---

## What is GitHub?

GitHub is like Google Drive but for code. You upload your files there, and other services (like Vercel) can read them to put your site online. It's free.

## What is Vercel?

Vercel takes your files from GitHub and turns them into a live website. Every time you update files on GitHub, Vercel automatically updates the website. Also free.

---

## Step 1: Create a GitHub Account (2 minutes)

1. Go to [github.com](https://github.com)
2. Click **Sign up**
3. Use your email, pick a username and password
4. Verify your email — done

## Step 2: Create a Repository (2 minutes)

A "repository" (repo) is just a folder on GitHub.

1. Click the **+** button (top right) → **New repository**
2. Name it: `tilapiya-crm`
3. Set it to **Private** (so nobody else can see your code)
4. Check **"Add a README file"**
5. Click **Create repository**

## Step 3: Upload Your Files (3 minutes)

1. In your new repo, click **Add file** → **Upload files**
2. Open your `Tilapiya` folder on your computer
3. Drag these files/folders into the upload area:
   - The entire `dashboard` folder (contains index.html, manifest.json, sw.js)
   - `supabase_schema.sql`
   - `phase1_whatsapp_handler.json`
   - `phase2_reminders.json`
   - `phase3_post_visit.json`
   - `phase4_crm_campaigns.json`
   - `SETUP_GUIDE.md`
4. Scroll down, click **Commit changes**
5. Wait for the upload to finish

## Step 4: Connect Vercel (5 minutes)

1. Go to [vercel.com](https://vercel.com)
2. Click **Sign Up** → choose **Continue with GitHub**
3. Authorize Vercel to access your GitHub
4. Click **Add New...** → **Project**
5. Find `tilapiya-crm` in the list and click **Import**
6. **IMPORTANT — Change these settings:**
   - **Root Directory**: Click **Edit** and type `dashboard`
   - **Framework Preset**: Select **Other**
7. Click **Deploy**
8. Wait ~30 seconds — you'll get a URL like: `https://tilapiya-crm.vercel.app`

**That's your live dashboard!** Share this URL with the restaurant.

## Step 5: Set Up Your Supabase Connection

Before the dashboard works, you need to put your Supabase keys in:

1. On GitHub, navigate to `dashboard/index.html`
2. Click the **pencil icon** (edit)
3. Find these two lines near the top:
   ```
   const SUPABASE_URL  = 'YOUR_SUPABASE_URL';
   const SUPABASE_ANON = 'YOUR_SUPABASE_ANON_KEY';
   ```
4. Replace them with your real Supabase values (from Supabase → Settings → API)
5. Click **Commit changes**
6. Vercel will automatically redeploy — your dashboard is now connected!

---

## How to Update the Dashboard Later

1. Go to your repo on GitHub
2. Edit the file directly on GitHub (pencil icon), OR
3. Upload new files (Add file → Upload files)
4. Every time you commit a change, Vercel auto-deploys in ~30 seconds

---

## Custom Domain (Optional, Free)

If you want a nicer URL like `crm.tilapiya.com`:

1. In Vercel, go to your project → **Settings** → **Domains**
2. Type your domain name and click **Add**
3. Vercel shows you DNS records to add at your domain provider
4. Once DNS propagates (~5-30 minutes), your custom domain works with free HTTPS

---

## For Each New Restaurant Client

1. Create a new Supabase project (free tier)
2. Run the `supabase_schema.sql` in their SQL Editor
3. Update the dashboard's `SUPABASE_URL` and `SUPABASE_ANON` for that client
4. Either:
   - Deploy a separate Vercel project per client, OR
   - Use one dashboard and switch Supabase keys per client
5. Set up their n8n workflows with their WhatsApp number
6. Charge them your setup + monthly fee

---

## Quick Reference

| What | Where |
|------|-------|
| Your code | github.com/YOUR-USERNAME/tilapiya-crm |
| Live dashboard | tilapiya-crm.vercel.app |
| Database | Your Supabase project dashboard |
| Workflows | Your n8n instance |
| WhatsApp | developers.facebook.com |

Everything stays free until you outgrow the free tiers (which handles ~1,000 WhatsApp conversations/month and 50,000 database rows easily).
