/**
 * WhatsApp Baileys Bridge Server (v2 - Multi-Company & Crash-Resistant)
 * Compatible with Node.js 18/20/22 on Railway (Nixpacks & Docker), Render, VPS, or Local PC.
 */

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
  Browsers,
  delay,
} = require("@whiskeysockets/baileys");

// Anti-crash process handlers (essential for cloud hosting stability)
process.on("uncaughtException", (err) => {
  console.error("[CRASH PREVENTED] Uncaught Exception:", err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[CRASH PREVENTED] Unhandled Rejection:", reason?.message || reason);
});

const app = express();
app.use(express.json({ limit: "50mb" }));

const PORT = Number(process.env.PORT) || 3000;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.ADMIN_TOKEN || "";
const BASE_AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, "auth_info_baileys");

if (!fs.existsSync(BASE_AUTH_DIR)) {
  fs.mkdirSync(BASE_AUTH_DIR, { recursive: true });
}

// Security: Verify Bearer Token on API routes
function requireAuth(req, res, next) {
  if (!BRIDGE_TOKEN) return next();
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (token !== BRIDGE_TOKEN) {
    return res.status(401).json({ ok: false, error: "Invalid or missing Bridge Token" });
  }
  next();
}

// ==============================================================================
// Multi-Company / Multi-Tenant Session Management
// ==============================================================================

const sessions = new Map();

function sanitizeCompanyId(id) {
  if (!id) return "default";
  return (
    String(id)
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 64) || "default"
  );
}

function extractCompanyId(req) {
  const fromHeader = req.headers["x-company-id"] || req.headers["x-session-id"];
  const fromQuery = req.query?.companyId || req.query?.sessionId;
  const fromBody = req.body && (req.body.companyId || req.body.sessionId);
  return sanitizeCompanyId(fromHeader || fromQuery || fromBody || "default");
}

function getCompanyAuthDir(companyId) {
  const safeId = sanitizeCompanyId(companyId);
  return path.join(BASE_AUTH_DIR, `session_${safeId}`);
}

async function getOrCreateSession(companyId, autoConnect = true) {
  const id = sanitizeCompanyId(companyId);
  if (sessions.has(id)) {
    const s = sessions.get(id);
    if (autoConnect && s.status === "offline" && !s.sock && !s.reconnectTimer) {
      initCompanyConnection(id).catch((err) =>
        console.error(`[Company: ${id}] Auto-connect error:`, err?.message || err),
      );
    }
    return s;
  }

  const session = {
    id,
    sock: null,
    status: "offline",
    qr: null,
    phone: null,
    pairingCode: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    lastError: null,
  };
  sessions.set(id, session);

  if (autoConnect) {
    await initCompanyConnection(id);
  }
  return session;
}

async function initCompanyConnection(companyId) {
  const id = sanitizeCompanyId(companyId);
  let session = sessions.get(id);
  if (!session) {
    session = {
      id,
      sock: null,
      status: "offline",
      qr: null,
      phone: null,
      pairingCode: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      lastError: null,
    };
    sessions.set(id, session);
  }

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  const sessionDir = getCompanyAuthDir(id);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  session.status = "connecting";
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1015901307],
    }));

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: id === "default",
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      defaultQueryTimeoutMs: 60000,
    });

    session.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        session.status = "qr";
        try {
          session.qr = await QRCode.toDataURL(qr);
        } catch {
          session.qr = qr;
        }
        session.lastError = null;
        console.log(`[Company: ${id}] New QR Code ready to scan`);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMessage =
          lastDisconnect?.error?.message ||
          (statusCode ? `Status code ${statusCode}` : "Connection closed");
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `[Company: ${id}] Connection closed (code: ${statusCode}, reason: ${errMessage}). Reconnect? ${shouldReconnect}`,
        );

        session.status = "offline";
        session.qr = null;
        session.phone = null;
        session.pairingCode = null;
        session.lastError = errMessage;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`[Company: ${id}] Session logged out. Cleaning directory...`);
          try {
            if (fs.existsSync(sessionDir)) {
              fs.rmSync(sessionDir, { recursive: true, force: true });
            }
          } catch (e) {}
          session.reconnectAttempts = 0;
          await delay(2000);
          initCompanyConnection(id).catch(() => {});
        } else if (shouldReconnect) {
          session.reconnectAttempts++;
          const waitMs = Math.min(30000, session.reconnectAttempts * 3000);
          console.log(`[Company: ${id}] Reconnecting in ${waitMs / 1000}s...`);
          session.reconnectTimer = setTimeout(() => {
            initCompanyConnection(id).catch((err) =>
              console.error(`[Company: ${id}] Reconnect error:`, err?.message || err),
            );
          }, waitMs);
        }
      } else if (connection === "open") {
        session.status = "connected";
        session.qr = null;
        session.pairingCode = null;
        session.lastError = null;
        session.reconnectAttempts = 0;
        const jid = sock.user?.id || "";
        session.phone = jid.split(":")[0] || jid.split("@")[0] || null;
        console.log(`[Company: ${id}] WhatsApp connected successfully! Phone: +${session.phone}`);
      }
    });

    return session;
  } catch (err) {
    console.error(`[Company: ${id}] Init socket error:`, err?.message || err);
    session.status = "offline";
    session.lastError = err?.message || String(err);
    return session;
  }
}

// Auto-restore any existing company sessions from disk on startup
async function restoreSavedSessions() {
  try {
    const items = fs.readdirSync(BASE_AUTH_DIR, { withFileTypes: true });
    let found = false;
    for (const item of items) {
      if (item.isDirectory() && item.name.startsWith("session_")) {
        const companyId = item.name.replace(/^session_/, "");
        console.log(`Restoring saved session for company: ${companyId}`);
        found = true;
        await getOrCreateSession(companyId, true);
      }
    }
    if (!found || !sessions.has("default")) {
      await getOrCreateSession("default", true);
    }
  } catch (err) {
    console.error("Error restoring sessions from disk:", err);
    await getOrCreateSession("default", true);
  }
}

// Helper: Download image to buffer
async function fetchImageBuffer(imageUrl) {
  if (imageUrl.startsWith("data:")) {
    const base64Data = imageUrl.split(",")[1];
    return Buffer.from(base64Data, "base64");
  }
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// ==============================================================================
// REST Endpoints
// ==============================================================================

// 1. Health check & Root (No Auth, for cloud probes)
app.get(["/", "/health", "/ping"], (req, res) => {
  const defaultSession = sessions.get("default");
  res.json({
    ok: true,
    service: "WhatsApp Baileys Bridge",
    version: "2.0.0",
    status: defaultSession?.status || "offline",
    phone: defaultSession?.phone || null,
    uptime: Math.round(process.uptime()),
    activeSessions: sessions.size,
  });
});

// 2. Status for a company or default
app.get("/status", requireAuth, async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = await getOrCreateSession(companyId, true);
  res.json({
    ok: true,
    companyId: session.id,
    status: session.status,
    qr: session.qr,
    phone: session.phone,
    pairingCode: session.pairingCode || null,
    error: session.lastError || null,
  });
});

// 3. Request 8-character Pairing Code by phone number (no QR scanning needed)
app.post("/pair", requireAuth, async (req, res) => {
  const companyId = extractCompanyId(req);
  const { phone } = req.body || {};
  if (!phone) {
    return res.status(400).json({
      ok: false,
      error: "رقم الهاتف مطلوب مع كود الدولة (مثال: 201012345678 أو 9665xxxxxxxx)",
    });
  }

  const cleanPhone = String(phone).replace(/[^0-9]/g, "");
  if (cleanPhone.length < 8) {
    return res.status(400).json({ ok: false, error: "رقم الهاتف غير صحيح أو قصير جداً" });
  }

  let session = sessions.get(companyId);
  if (!session || !session.sock) {
    session = await initCompanyConnection(companyId);
  }

  let attempts = 0;
  while ((!session.sock || session.status === "offline") && attempts < 12) {
    await delay(500);
    attempts++;
  }

  if (!session.sock) {
    return res.status(500).json({ ok: false, error: "تعذر فتح اتصال السوكيت للواتساب" });
  }

  try {
    const code = await session.sock.requestPairingCode(cleanPhone);
    session.pairingCode = code;
    console.log(`[Company: ${companyId}] Pairing code generated: ${code} for phone: +${cleanPhone}`);
    res.json({ ok: true, companyId, code, phone: cleanPhone });
  } catch (err) {
    console.error(`[Company: ${companyId}] Pairing code error:`, err);
    res.status(500).json({ ok: false, error: err?.message || "فشل توليد كود الربط من واتساب" });
  }
});

// 4. Force connect / trigger QR
app.post("/connect", requireAuth, async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = await initCompanyConnection(companyId);
  res.json({ ok: true, companyId, status: session.status, qr: session.qr });
});

// 5. List all active company sessions
app.get("/sessions", requireAuth, (req, res) => {
  const list = [];
  for (const [id, s] of sessions.entries()) {
    list.push({
      companyId: id,
      status: s.status,
      phone: s.phone,
      hasQr: Boolean(s.qr),
    });
  }
  res.json({ ok: true, count: list.length, sessions: list });
});

// 6. Participating Groups
app.get("/groups", requireAuth, async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = await getOrCreateSession(companyId, false);

  if (session.status !== "connected" || !session.sock) {
    return res.status(400).json({
      ok: false,
      companyId,
      error: "WhatsApp is not connected.",
    });
  }

  try {
    const participating = await session.sock.groupFetchAllParticipating();
    const groups = Object.values(participating).map((g) => ({
      id: g.id,
      name: g.subject || "Unnamed Group",
    }));
    res.json(groups);
  } catch (err) {
    console.error(`[Company: ${companyId}] Failed to fetch groups:`, err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to fetch groups" });
  }
});

// 7. Channel / Newsletter metadata by link
app.post("/channel", requireAuth, async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = await getOrCreateSession(companyId, false);

  if (session.status !== "connected" || !session.sock) {
    return res.status(400).json({
      ok: false,
      companyId,
      error: "WhatsApp is not connected.",
    });
  }

  const { link } = req.body || {};
  if (!link) return res.status(400).json({ ok: false, error: "Channel link is required" });

  try {
    const match = link.match(/channel\/([a-zA-Z0-9_-]+)/);
    const code = match ? match[1] : link.trim();
    const metadata = await session.sock.newsletterMetadata("invite", code);
    res.json({
      ok: true,
      companyId,
      id: metadata.id,
      name: metadata.name || "WhatsApp Channel",
    });
  } catch (err) {
    console.error(`[Company: ${companyId}] Failed to resolve channel:`, err);
    res.status(400).json({
      ok: false,
      error: "Could not find channel. Ensure link is correct and phone has access.",
    });
  }
});

// 8. Send Image + Caption to Group / Channel / Status
app.post("/send", requireAuth, async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = await getOrCreateSession(companyId, false);

  if (session.status !== "connected" || !session.sock) {
    return res.status(400).json({ ok: false, error: "WhatsApp is not connected" });
  }

  const { groupId, imageUrl, caption = "", mentions = [] } = req.body || {};
  if (!imageUrl) {
    return res.status(400).json({ ok: false, error: "imageUrl is required" });
  }

  if (groupId === "status@broadcast") {
    req.url = "/send-status";
    return app._router.handle(req, res);
  }

  if (!groupId) {
    return res.status(400).json({ ok: false, error: "groupId is required" });
  }

  try {
    const buffer = await fetchImageBuffer(imageUrl);
    const messagePayload = {
      image: buffer,
      caption: caption || "",
    };

    if (Array.isArray(mentions) && mentions.length > 0) {
      messagePayload.mentions = mentions;
    }

    if (groupId.endsWith("@newsletter")) {
      await session.sock.sendMessage(groupId, messagePayload);
    } else {
      const targetJid = groupId.includes("@") ? groupId : `${groupId}@g.us`;
      await session.sock.sendMessage(targetJid, messagePayload);
    }

    console.log(`[Company: ${companyId}] Message sent to ${groupId}`);
    res.json({ ok: true, companyId });
  } catch (err) {
    console.error(`[Company: ${companyId}] Error sending message:`, err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to send message" });
  }
});

// 9. Send Story (Status) with optional group mention
app.post("/send-status", requireAuth, async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = await getOrCreateSession(companyId, false);

  if (session.status !== "connected" || !session.sock) {
    return res.status(400).json({ ok: false, error: "WhatsApp is not connected" });
  }

  const { imageUrl, caption = "", mentionGroupId } = req.body || {};
  if (!imageUrl) {
    return res.status(400).json({ ok: false, error: "imageUrl is required" });
  }

  try {
    const buffer = await fetchImageBuffer(imageUrl);
    const messagePayload = {
      image: buffer,
      caption: caption || "",
    };

    if (mentionGroupId) {
      const mentionJid = mentionGroupId.includes("@") ? mentionGroupId : `${mentionGroupId}@g.us`;
      messagePayload.contextInfo = {
        mentionedJid: [mentionJid],
      };
    }

    await session.sock.sendMessage("status@broadcast", messagePayload);
    console.log(`[Company: ${companyId}] Status story published successfully`);
    res.json({ ok: true, companyId });
  } catch (err) {
    console.error(`[Company: ${companyId}] Error publishing status:`, err);
    res.status(500).json({ ok: false, error: err?.message || "Failed to post status" });
  }
});

// 10. Logout for a company
app.post("/logout", requireAuth, async (req, res) => {
  const companyId = extractCompanyId(req);
  const session = sessions.get(companyId);

  try {
    if (session?.sock) {
      await session.sock.logout().catch(() => {});
    }
  } catch (e) {}

  const sessionDir = getCompanyAuthDir(companyId);
  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  } catch (e) {}

  if (session) {
    session.status = "offline";
    session.qr = null;
    session.phone = null;
    session.pairingCode = null;
    session.lastError = null;
    session.reconnectAttempts = 0;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  setTimeout(() => {
    initCompanyConnection(companyId).catch(() => {});
  }, 1500);

  res.json({ ok: true, companyId, message: `Company '${companyId}' logged out successfully.` });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp Multi-Company Baileys Bridge v2 running on port ${PORT}`);
  restoreSavedSessions().catch((err) => console.error("Initial restore error:", err));
});
