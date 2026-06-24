/**
 * Tilapiya CRM - WhatsApp bridge (24/7, pairing-code mode)
 *
 * Connects a real WhatsApp account (linked as a "Linked Device" via pairing
 * code) to the Tilapiya CRM brain. Every inbound message is sent to the brain
 * endpoint, which generates an AI reply, saves the conversation in Supabase,
 * and returns the reply text. This bridge then sends that reply back over
 * WhatsApp. No Meta Cloud API needed.
 *
 * Configure via .env (see .env.example).
 */
require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const BRAIN_URL = process.env.BRAIN_URL || "https://tilapiya-crm2.vercel.app/api/wa-bridge";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "0ed3044a61fc16eb2d599bae52f3d75849987e768520dd72";
const PAIR_NUMBER = (process.env.PAIR_NUMBER || "").replace(/[^\d]/g, "");
const REPLY_TO_GROUPS = (process.env.REPLY_TO_GROUPS || "false").toLowerCase() === "true";
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 25000);

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// Strip emojis and tidy whitespace, for a clean restaurant tone.
function clean(s) {
  if (!s) return s;
  return String(s)
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,!?:;])/g, "$1")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

if (typeof fetch !== "function") {
  console.error("[tilapiya-bridge] Node 18+ required (no global fetch). Run: node -v");
  process.exit(1);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./.wwebjs_pair" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  },
});

let pairingAsked = false;
client.on("qr", async (qr) => {
  if (PAIR_NUMBER && !pairingAsked) {
    pairingAsked = true;
    try {
      const code = await client.requestPairingCode(PAIR_NUMBER);
      const pretty = code && code.length === 8 ? code.slice(0, 4) + "-" + code.slice(4) : code;
      console.log("\n\n##############################################");
      console.log("#   TILAPIYA WHATSAPP LINK CODE:   " + pretty);
      console.log("##############################################");
      console.log("On the phone holding number " + PAIR_NUMBER + ":");
      console.log("  WhatsApp > Settings > Linked Devices > Link a device");
      console.log("  > 'Link with phone number instead' > type the code above.");
      console.log("Then keep this window open - the bot will start replying.\n\n");
      return;
    } catch (e) {
      console.log("[tilapiya-bridge] pairing code failed (" + (e && e.message) + "), showing QR instead:");
    }
  }
  console.log("\n=============== SCAN THIS QR ===============");
  qrcode.generate(qr, { small: true });
  console.log("===========================================\n");
});

client.on("loading_screen", (p) => log("[tilapiya-bridge] loading " + p + "%"));
client.on("authenticated", () => log("[tilapiya-bridge] authenticated OK"));
client.on("auth_failure", (m) => log("[tilapiya-bridge] AUTH FAILURE", m));
client.on("ready", () => log("[tilapiya-bridge] CONNECTED. Listening for messages..."));
client.on("disconnected", (r) => { log("[tilapiya-bridge] disconnected:", r, "- restarting"); process.exit(1); });

client.on("message", async (msg) => {
  try {
    if (msg.fromMe) return;
    if (msg.isStatus) return;
    if (msg.type !== "chat") return;
    if (!REPLY_TO_GROUPS && msg.from.endsWith("@g.us")) return;
    if (msg.from.endsWith("@newsletter") || msg.from.includes("broadcast")) return;

    const text = (msg.body || "").trim();
    if (!text) return;

    // Customer's WhatsApp number (digits, e.g. "94771234567")
    const from = (msg.from.split("@")[0] || "").replace(/[^\d]/g, "");
    // Their saved name in the bridge's contacts (best-effort)
    let name;
    try {
      const contact = await msg.getContact();
      name = (contact && (contact.pushname || contact.name || contact.shortName)) || undefined;
    } catch (_) { /* fine, brain falls back to phone */ }

    log("IN  <-", from, ":", text.slice(0, 60));

    const reply = clean(await askBrain(from, text, name));
    if (reply && reply.trim()) {
      await msg.reply(reply);
      log("OUT ->", from, ":", reply.slice(0, 60));
    } else {
      log("[tilapiya-bridge] no reply for", from);
    }
  } catch (e) {
    log("[tilapiya-bridge] handler error:", e && e.message ? e.message : e);
  }
});

async function askBrain(from, text, name) {
  for (let i = 1; i <= 3; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(BRAIN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + BRIDGE_SECRET,
        },
        body: JSON.stringify({ from: from, text: text, name: name }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data.reply || null;
      log("[tilapiya-bridge] brain HTTP", res.status, (data && data.error) ? data.error : "");
      if (res.status === 401) return null;
    } catch (e) {
      log("[tilapiya-bridge] brain attempt " + i + "/3 failed:", e && e.message ? e.message : e);
      if (i < 3) await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    }
  }
  return null;
}

process.on("unhandledRejection", (e) => log("[tilapiya-bridge] unhandledRejection:", e && e.message));
process.on("uncaughtException", (e) => { log("[tilapiya-bridge] uncaughtException:", e && e.message); process.exit(1); });

if (PAIR_NUMBER) {
  log("[tilapiya-bridge] starting... requesting link code for " + PAIR_NUMBER);
} else {
  log("[tilapiya-bridge] starting... no PAIR_NUMBER set, will show a QR code to scan");
}
client.initialize();
