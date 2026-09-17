#!/usr/bin/env node
// Open Dialer — self-hosted token server (zero dependencies, Node 18+).
//
// This is the ONLY place Twilio credentials live: your machine, your secrets.
// The browser extension asks THIS server for a short-lived Twilio Voice access
// token; the server signs it with YOUR Twilio account. Nothing is sent to any
// third party beyond Twilio itself.
//
// Setup:
//   1. cp .env.example .env   — then fill in your Twilio values
//   2. node server.js
//   3. In the extension Settings, set Token server URL = http://localhost:3001
//
// Endpoints:
//   GET /health          -> { ok, callerId }
//   GET /token           -> { token }   (Twilio Voice access token, ~1h TTL)

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------- minimal .env loader ----------
(function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET,
  TWILIO_CALLER_ID,          // e.g. +14155551234 — your Twilio number
  TWILIO_TWIML_APP_SID,      // TwiML App SID (starts with AP...)
  PORT = "3001",
} = process.env;

for (const [k, v] of Object.entries({
  TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_CALLER_ID, TWILIO_TWIML_APP_SID,
})) {
  if (!v) {
    console.error(`Missing ${k} — copy .env.example to .env and fill in your Twilio values.`);
    process.exit(1);
  }
}

// ---------- Twilio access token (JWT) — signed locally, no SDK needed ----------
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mintVoiceToken(identity) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = 60 * 60; // 1 hour
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" }));
  const payload = b64url(JSON.stringify({
    jti: `${TWILIO_API_KEY_SID}-${now}`,
    iss: TWILIO_API_KEY_SID,
    sub: TWILIO_ACCOUNT_SID,
    nbf: now,
    exp: now + ttl,
    grants: {
      identity,
      voice: {
        incoming: { allow: true },
        outgoing: {
          application_sid: TWILIO_TWIML_APP_SID,
          params: { Identity: identity },
        },
      },
    },
  }));
  const sig = crypto
    .createHmac("sha256", TWILIO_API_KEY_SECRET)
    .update(`${header}.${payload}`)
    .digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

// identity is arbitrary — one per browser/device is fine
const IDENTITY = "open-dialer-browser";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader("Access-Control-Allow-Origin", "*"); // extension origin varies
  if (url.pathname === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, callerId: TWILIO_CALLER_ID }));
    return;
  }
  if (url.pathname === "/token") {
    res.setHeader("Content-Type", "application/json");
    try {
      res.end(JSON.stringify({ token: mintVoiceToken(IDENTITY) }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err.message ?? err) }));
    }
    return;
  }
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(Number(PORT), () => {
  console.log(`Open Dialer token server listening on http://localhost:${PORT}`);
  console.log(`  Account SID : ${TWILIO_ACCOUNT_SID.slice(0, 8)}…`);
  console.log(`  Caller ID   : ${TWILIO_CALLER_ID}`);
  console.log(`  TwiML App   : ${TWILIO_TWIML_APP_SID}`);
  console.log(`\nPoint the extension Settings → Token server URL at http://localhost:${PORT}`);
});
