const express = require("express");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  delay
} = require("@whiskeysockets/baileys");

// Anti-crash handlers for cloud runners (Railway, etc.)
process.on("uncaughtException", (err) => {
  console.error("[CRASH PREVENTED] Uncaught Exception:", err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[CRASH PREVENTED] Unhandled Rejection:", reason?.message || reason);
});

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const AUTH_FOLDER = path.join(__dirname, "auth_info_baileys");

let sock = null;
let qrCodeDataUrl = null;
let connectionStatus = "offline"; // offline, connecting, connected
let myPhoneNumber = null;
let reconnectAttempts = 0;

// Auth middleware
function requireAuth(req, res, next) {
  if (!BRIDGE_TOKEN) return next();
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (token !== BRIDGE_TOKEN) {
    return res.status(401).json({ error: "Invalid or missing Bridge Token" });
  }
  next();
}

async function startSock() {
  try {
    connectionStatus = "connecting";
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

    sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: true,
      auth: state,
      browser: ["PharmacyPostPro", "Chrome", "1.0.0"],
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      defaultQueryTimeoutMs: 60000
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          qrCodeDataUrl = await QRCode.toDataURL(qr);
        } catch (e) {
          qrCodeDataUrl = qr;
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`Connection closed (code: ${statusCode}). Reconnect? ${shouldReconnect}`);

        qrCodeDataUrl = null;
        connectionStatus = "offline";
        myPhoneNumber = null;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("Session logged out. Clearing credentials folder...");
          try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          } catch (e) {}
          await delay(2000);
          startSock();
        } else if (shouldReconnect) {
          reconnectAttempts++;
          const waitMs = Math.min(30000, reconnectAttempts * 3000);
          console.log(`Reconnecting in ${waitMs / 1000}s...`);
          await delay(waitMs);
          startSock();
        }
      } else if (connection === "open") {
        connectionStatus = "connected";
        qrCodeDataUrl = null;
        reconnectAttempts = 0;
        const jid = sock?.user?.id || "";
        myPhoneNumber = jid.split(":")[0] || jid.split("@")[0] || null;
        console.log(`WhatsApp connected successfully! Phone: ${myPhoneNumber}`);
      }
    });
  } catch (err) {
    console.error("Error starting Baileys socket:", err);
    connectionStatus = "offline";
    setTimeout(startSock, 5000);
  }
}

// 1. Health check & Root
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "WhatsApp Baileys Bridge",
    status: connectionStatus,
    phone: myPhoneNumber,
    uptime: Math.round(process.uptime())
  });
});

// 2. Status
app.get("/status", requireAuth, (req, res) => {
  res.json({
    status: connectionStatus,
    qr: qrCodeDataUrl,
    phone: myPhoneNumber
  });
});

// 3. Participating Groups
app.get("/groups", requireAuth, async (req, res) => {
  if (connectionStatus !== "connected" || !sock) {
    return res.status(400).json({ error: "WhatsApp is not connected." });
  }
  try {
    const participating = await sock.groupFetchAllParticipating();
    const groups = Object.values(participating).map((g) => ({
      id: g.id,
      name: g.subject || "Unnamed Group"
    }));
    res.json(groups);
  } catch (err) {
    console.error("Failed to fetch groups:", err);
    res.status(500).json({ error: err?.message || "Failed to fetch groups" });
  }
});

// 4. Channel / Newsletter metadata by link
app.post("/channel", requireAuth, async (req, res) => {
  if (connectionStatus !== "connected" || !sock) {
    return res.status(400).json({ error: "WhatsApp is not connected." });
  }
  const { link } = req.body || {};
  if (!link) return res.status(400).json({ error: "Channel link is required" });

  try {
    // Extract code from https://whatsapp.com/channel/0029Va...
    const match = link.match(/channel\/([a-zA-Z0-9_-]+)/);
    const code = match ? match[1] : link.trim();
    const metadata = await sock.newsletterMetadata("invite", code);
    res.json({
      id: metadata.id,
      name: metadata.name || "WhatsApp Channel"
    });
  } catch (err) {
    console.error("Failed to resolve channel:", err);
    res.status(400).json({ error: "Could not find channel. Ensure link is correct and bot account has access." });
  }
});

// 5. Send Image + Caption to Group / Channel / Status
app.post("/send", requireAuth, async (req, res) => {
  if (connectionStatus !== "connected" || !sock) {
    return res.status(400).json({ error: "WhatsApp is not connected" });
  }

  const { groupId, imageUrl, caption = "", mentions = [] } = req.body || {};
  if (!groupId || !imageUrl) {
    return res.status(400).json({ error: "groupId and imageUrl are required" });
  }

  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Failed to download image (status: ${imgRes.status})`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    const messagePayload = {
      image: buffer,
      caption: caption
    };

    if (Array.isArray(mentions) && mentions.length > 0) {
      messagePayload.mentions = mentions;
    }

    // Check if target is a newsletter/channel
    if (groupId.endsWith("@newsletter")) {
      await sock.sendMessage(groupId, messagePayload);
    } else if (groupId === "status@broadcast") {
      // WhatsApp Status Story
      await sock.sendMessage("status@broadcast", messagePayload);
    } else {
      // Standard Group or Contact JID
      const targetJid = groupId.includes("@") ? groupId : `${groupId}@g.us`;
      await sock.sendMessage(targetJid, messagePayload);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to send WhatsApp message:", err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to send message" });
  }
});

// 6. Send Story (Status) with optional group mention
app.post("/send-status", requireAuth, async (req, res) => {
  if (connectionStatus !== "connected" || !sock) {
    return res.status(400).json({ error: "WhatsApp is not connected" });
  }

  const { imageUrl, caption = "", mentionGroupId } = req.body || {};
  if (!imageUrl) {
    return res.status(400).json({ error: "imageUrl is required" });
  }

  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error(`Failed to download image (status: ${imgRes.status})`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    const messagePayload = {
      image: buffer,
      caption: caption
    };

    if (mentionGroupId) {
      const mentionJid = mentionGroupId.includes("@") ? mentionGroupId : `${mentionGroupId}@g.us`;
      messagePayload.contextInfo = {
        mentionedJid: [mentionJid]
      };
    }

    await sock.sendMessage("status@broadcast", messagePayload);
    res.json({ ok: true });
  } catch (err) {
    console.error("Failed to post WhatsApp Status:", err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to post status" });
  }
});

// 7. Logout
app.post("/logout", requireAuth, async (req, res) => {
  try {
    if (sock) {
      await sock.logout().catch(() => {});
    }
  } catch (e) {}
  try {
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  } catch (e) {}
  connectionStatus = "offline";
  qrCodeDataUrl = null;
  myPhoneNumber = null;
  setTimeout(startSock, 2000);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`WhatsApp Bridge running on port ${PORT}`);
  startSock();
});
