/* eslint-disable @typescript-eslint/no-explicit-any */
// Polyfill crypto for Baileys (WebCrypto API)
const nodeCrypto = require('crypto');
(global as any).crypto = nodeCrypto.webcrypto || nodeCrypto;
(global as any).self = global;

import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import express from "express";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";

const PORT = process.env.PORT || 3001;
const AUTH_DIR = path.join(__dirname, "../.baileys_auth");
const QUEUE_FILE = path.join(__dirname, "../data/queue.json");

// ─── Config ───────────────────────────────────────────────────────────
const MAX_CONTACTS_PER_CAMPAIGN = 500;
const DELAY_MIN_MS = 10000;
const DELAY_MAX_MS = 20000;
const BATCH_SIZE = 25;
const BATCH_PAUSE_MS = 120000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 30000;

// ─── Types ────────────────────────────────────────────────────────────
interface QueuedMessage {
  id: string;
  phone: string;
  message: string;
  name: string;
  status: "pending" | "sending" | "sent" | "failed";
  error?: string;
  createdAt: string;
  sentAt?: string;
  retries: number;
}

interface Campaign {
  id: string;
  totalContacts: number;
  sent: number;
  failed: number;
  pending: number;
  message: string;
  createdAt: string;
  completedAt?: string;
  statuses: Record<string, QueuedMessage>;
}

// ─── State ────────────────────────────────────────────────────────────
let sock: any = null;
let connectionState: "disconnected" | "connecting" | "connected" | "qr_ready" | "pairing_code_ready" = "disconnected";
let qrCodeData: string | null = null;
let pairingCode: string | null = null;
let messageQueue: QueuedMessage[] = [];
let isProcessing = false;
let campaigns: Map<string, Campaign> = new Map();
let processingAbort = false;

function randomDelay(): number {
  return Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS) + DELAY_MIN_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validatePhone(phone: string): boolean {
  const cleaned = phone.replace(/[\s\-\(\)\+]/g, "");
  return /^\d{7,15}$/.test(cleaned);
}

// ─── Queue persistence ────────────────────────────────────────────────
function saveQueue() {
  const dir = path.dirname(QUEUE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify({
    queue: messageQueue,
    campaigns: Array.from(campaigns.entries()),
  }, null, 2));
}

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
      messageQueue = (data.queue || []).map((m: QueuedMessage) => ({
        ...m,
        retries: m.retries || 0,
        status: m.status === "sending" ? "pending" : m.status,
      }));
      campaigns = new Map(data.campaigns || []);
      for (const [, campaign] of campaigns) {
        campaign.pending = Object.values(campaign.statuses).filter((m) => m.status === "pending" || m.status === "sending").length;
      }
    }
  } catch {
    messageQueue = [];
    campaigns = new Map();
  }
}

// ─── WhatsApp client (Baileys) ────────────────────────────────────────
async function initWhatsApp() {
  if (connectionState === "connecting" || connectionState === "connected") return;

  connectionState = "connecting";
  console.log("🔌 Initializing Baileys WhatsApp client...");

  try {
    const auth = await useMultiFileAuthState(AUTH_DIR);
    const { state, saveCreds } = auth;

    // Fetch the latest supported version from Baileys
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update: any) => {
      // Log the full update to diagnose
      console.log("📡 Connection update raw:", JSON.stringify(update, (_, v) => typeof v === 'bigint' ? v.toString() : v));

      const connection = update.connection;

      // QR code may come as { qr: "..." } without .connection
      if (update.qr) {
        qrCodeData = update.qr;
        pairingCode = null;
        connectionState = "qr_ready";
        console.log("📱 QR code ready — scan with WhatsApp");
        return;
      }

      if (!connection) {
        // Unknown update shape, ignore
        return;
      }

      console.log("📡 Connection update:", connection);

      if (connection === "open") {
        connectionState = "connected";
        qrCodeData = null;
        pairingCode = null;
        console.log("✅ WhatsApp connected!");
        processQueue().catch(console.error);
      } else if (connection === "close") {
        const { reason } = update;
        console.log("❌ Disconnected:", reason);

        if (reason === DisconnectReason.loggedOut) {
          connectionState = "disconnected";
          qrCodeData = null;
          pairingCode = null;
          processingAbort = true;
          setTimeout(initWhatsApp, 5000);
        } else {
          setTimeout(initWhatsApp, 5000);
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }: any) => {
      for (const msg of messages) {
        if (!msg.key.fromMe) {
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "[media]";
          console.log(`📩 ${msg.key.remoteJid}: "${text}".slice(0, 50)`);
        }
      }
    });

  } catch (err: any) {
    console.error("❌ Failed to initialize Baileys:", err.message);
    connectionState = "disconnected";
    setTimeout(initWhatsApp, 10000);
  }
}

// ─── Send a single message ────────────────────────────────────────────
async function sendMessage(phone: string, message: string): Promise<boolean> {
  if (!sock || connectionState !== "connected") {
    throw new Error("WhatsApp not connected");
  }

  const chatId = phone.includes("@c.us") ? phone : `${phone}@c.us`;

  try {
    await sock.sendMessage(chatId, { text: message });
    return true;
  } catch (err: any) {
    console.error(`  ❌ Failed to send to ${phone}:`, err.message);
    return false;
  }
}

// ─── Process the queue with smart delays ──────────────────────────────
async function processQueue() {
  if (isProcessing) return;
  if (connectionState !== "connected") return;

  const pending = messageQueue.filter((m) => m.status === "pending");
  if (pending.length === 0) return;

  isProcessing = true;
  processingAbort = false;
  console.log(`📬 Processing ${pending.length} queued messages...`);

  let sentInBatch = 0;
  let totalSent = 0;

  for (const msg of messageQueue) {
    if (processingAbort) {
      console.log("⚠️ Processing aborted (connection change).");
      break;
    }

    if (msg.status !== "pending") continue;

    if (connectionState !== "connected") {
      console.log("⚠️ Connection lost. Pausing queue.");
      msg.status = "pending";
      break;
    }

    msg.status = "sending";
    saveQueue();

    const success = await sendMessage(msg.phone, msg.message);

    if (success) {
      msg.status = "sent";
      msg.sentAt = new Date().toISOString();
      sentInBatch++;
      totalSent++;
    } else {
      msg.retries++;
      if (msg.retries < MAX_RETRIES) {
        msg.status = "pending";
        console.log(`  🔄 Retry ${msg.retries}/${MAX_RETRIES} for ${msg.name} in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      } else {
        msg.status = "failed";
        msg.error = `Failed after ${MAX_RETRIES} retries`;
      }
    }

    // Update campaign stats
    for (const [id, campaign] of campaigns) {
      if (campaign.statuses[msg.id]) {
        campaign.statuses[msg.id] = msg;
        campaign.sent = Object.values(campaign.statuses).filter((m) => m.status === "sent").length;
        campaign.failed = Object.values(campaign.statuses).filter((m) => m.status === "failed").length;
        campaign.pending = Object.values(campaign.statuses).filter((m) => m.status === "pending" || m.status === "sending").length;
        if (campaign.pending === 0) campaign.completedAt = new Date().toISOString();
      }
    }

    saveQueue();
    console.log(`  ✅ ${msg.name} (${msg.phone}) | batch: ${sentInBatch}/${BATCH_SIZE} | total: ${totalSent}`);

    // Batch pause
    if (sentInBatch >= BATCH_SIZE) {
      console.log(`  ⏸️ Batch of ${BATCH_SIZE} complete. Pausing ${BATCH_PAUSE_MS / 1000}s to avoid detection...`);
      await sleep(BATCH_PAUSE_MS);
      sentInBatch = 0;
    } else {
      await sleep(randomDelay());
    }
  }

  isProcessing = false;
  console.log("✅ Queue processing complete.");
}

// ─── Express API ──────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    whatsapp: connectionState,
    queueSize: messageQueue.filter((m) => m.status === "pending").length,
    totalQueued: messageQueue.length,
    isProcessing,
    config: {
      maxContacts: MAX_CONTACTS_PER_CAMPAIGN,
      delayRange: `${DELAY_MIN_MS / 1000}-${DELAY_MAX_MS / 1000}s`,
      batchSize: BATCH_SIZE,
      batchPause: `${BATCH_PAUSE_MS / 1000}s`,
      maxRetries: MAX_RETRIES,
    },
  });
});

// Connection status
app.get("/status", (_req, res) => {
  res.json({
    connected: connectionState === "connected",
    state: connectionState,
    hasQR: !!qrCodeData,
    pairingCode: pairingCode,
  });
});

// QR code as data URL
app.get("/qr", async (_req, res) => {
  if (!qrCodeData) {
    return res.status(404).json({ error: "No QR code available yet." });
  }
  try {
    const qrImage = await QRCode.toDataURL(qrCodeData);
    res.json({ qr: qrImage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Request pairing code (phone number method)
app.post("/pairing-code", async (req, res) => {
  if (!sock) {
    return res.status(503).json({ error: "WhatsApp client not initialized" });
  }
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ error: "phoneNumber required (with country code, e.g. 264811234567)" });
  }
  try {
    pairingCode = await sock.requestPairingCode(phoneNumber);
    res.json({ code: pairingCode, message: "Enter this code in WhatsApp → Settings → Linked Devices → Link with phone number" });
  } catch (err: any) {
    console.error("Pairing code error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Campaign API ─────────────────────────────────────────────────────

// Send campaign
app.post("/campaign", (req, res) => {
  if (connectionState !== "connected") {
    return res.status(503).json({ error: "WhatsApp not connected. Scan QR first." });
  }

  const { contacts, message: msgTemplate } = req.body;

  if (!contacts?.length || !msgTemplate) {
    return res.status(400).json({ error: "contacts[] and message required" });
  }

  if (contacts.length > MAX_CONTACTS_PER_CAMPAIGN) {
    return res.status(400).json({
      error: `Maximum ${MAX_CONTACTS_PER_CAMPAIGN} contacts per campaign. You sent ${contacts.length}.`,
    });
  }

  // Validate and deduplicate
  const seen = new Set<string>();
  const validContacts = [];
  const invalid = [];

  for (const contact of contacts) {
    const phone = String(contact.phone || "").replace(/[\s\-\(\)\+]/g, "");
    if (!phone || !validatePhone(phone)) {
      invalid.push({ name: contact.name, phone, reason: "invalid phone" });
      continue;
    }
    if (seen.has(phone)) {
      invalid.push({ name: contact.name, phone, reason: "duplicate" });
      continue;
    }
    seen.add(phone);
    validContacts.push({ ...contact, phone });
  }

  if (validContacts.length === 0) {
    return res.status(400).json({ error: "No valid contacts found", invalid });
  }

  const campaignId = `c-${Date.now()}`;
  const statuses: Record<string, QueuedMessage> = {};

  for (const contact of validContacts) {
    const id = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const personalized = msgTemplate.replace(/\{name\}/g, (contact.name || "").split(" ")[0] || "");

    const queued: QueuedMessage = {
      id,
      phone: contact.phone,
      message: personalized,
      name: contact.name || contact.phone,
      status: "pending",
      createdAt: new Date().toISOString(),
      retries: 0,
    };

    messageQueue.push(queued);
    statuses[id] = queued;
  }

  const campaign: Campaign = {
    id: campaignId,
    totalContacts: validContacts.length,
    sent: 0,
    failed: 0,
    pending: validContacts.length,
    message: msgTemplate,
    createdAt: new Date().toISOString(),
    statuses,
  };

  campaigns.set(campaignId, campaign);
  saveQueue();

  if (!isProcessing && connectionState === "connected") processQueue();

  // Estimate delivery time
  const avgDelay = (DELAY_MIN_MS + DELAY_MAX_MS) / 2 / 1000;
  const batchOverhead = Math.floor(validContacts.length / BATCH_SIZE) * (BATCH_PAUSE_MS / 1000);
  const estimatedSeconds = Math.ceil(validContacts.length * avgDelay + batchOverhead);
  const estimatedMinutes = Math.ceil(estimatedSeconds / 60);

  console.log(`📤 Campaign ${campaignId}: ${validContacts.length} messages queued`);
  res.json({
    campaignId,
    queued: validContacts.length,
    invalid: invalid.length > 0 ? invalid : undefined,
    estimatedMinutes,
    message: `Campaign queued! ${validContacts.length} messages. Estimated delivery: ~${estimatedMinutes} minutes.`,
  });
});

// Campaign status
app.get("/campaign/:id", (req, res) => {
  const campaign = campaigns.get(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  res.json(campaign);
});

// All campaigns
app.get("/campaigns", (_req, res) => {
  res.json(Array.from(campaigns.values()).slice(-20));
});

// Disconnect
app.post("/disconnect", async (_req, res) => {
  if (sock) {
    try { await sock.logout(); } catch {}
    sock = null;
    connectionState = "disconnected";
    processingAbort = true;
  }
  res.json({ success: true });
});

// Reconnect
app.post("/reconnect", async (_req, res) => {
  if (connectionState === "connected") {
    return res.json({ message: "Already connected" });
  }
  if (!sock) {
    initWhatsApp();
  } else {
    try { await sock.connect(); } catch {}
  }
  res.json({ message: "Reconnecting..." });
});

// Retry failed messages in a campaign
app.post("/campaign/:id/retry", (req, res) => {
  const campaign = campaigns.get(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  let retried = 0;
  for (const msg of Object.values(campaign.statuses)) {
    if (msg.status === "failed") {
      msg.status = "pending";
      msg.retries = 0;
      msg.error = undefined;
      messageQueue.push(msg);
      campaign.statuses[msg.id] = msg;
      retried++;
    }
  }

  campaign.pending = Object.values(campaign.statuses).filter((m) => m.status === "pending" || m.status === "sending").length;
  campaign.failed = Object.values(campaign.statuses).filter((m) => m.status === "failed").length;
  campaign.completedAt = undefined;
  saveQueue();

  if (!isProcessing && retried > 0) processQueue();

  res.json({ message: `Retrying ${retried} failed messages`, retried });
});

// ─── Start ────────────────────────────────────────────────────────────
loadQueue();
initWhatsApp();

app.listen(PORT, () => {
  console.log(`\n🚀 Feasable WhatsApp Server (Baileys)`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   QR: http://localhost:${PORT}/qr`);
  console.log(`   Max contacts: ${MAX_CONTACTS_PER_CAMPAIGN}`);
  console.log(`   Delay: ${DELAY_MIN_MS / 1000}-${DELAY_MAX_MS / 1000}s`);
  console.log(`   Batch: ${BATCH_SIZE} msgs, then ${BATCH_PAUSE_MS / 1000}s pause`);
  console.log(`   Max retries: ${MAX_RETRIES}`);
  console.log(`   Waiting for WhatsApp connection...\n`);
});
