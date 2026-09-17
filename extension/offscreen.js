// Open Dialer offscreen document — owns the Twilio Device + WebRTC audio so
// calls survive panel close. Talks ONLY to the user's self-hosted token
// server (which holds their Twilio credentials) and nowhere else.

let device = null;
let activeCall = null;
let connectedAt = null;
let deviceMintedAt = 0;

// access tokens expire (~1h) — re-mint before dialing when the device is stale
const TOKEN_TTL_MS = 55 * 60 * 1000;

async function destroyDevice() {
  try { device?.destroy(); } catch (_) {}
  device = null;
  deviceMintedAt = 0;
}

function statusPatch(patch) {
  chrome.runtime.sendMessage({ target: "popup-status", ...patch }).catch(() => {});
}

async function getSetting(key, fallback) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get([key], (o) => resolve(o[key] ?? fallback));
    } catch (_) {
      resolve(fallback);
    }
  });
}

async function tokenFetch(base) {
  const res = await fetch(`${base}/token`);
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error ?? ""; } catch (_) {}
    throw new Error(`token server returned ${res.status}${detail ? ` — ${detail}` : ""}`);
  }
  const { token } = await res.json();
  if (!token) throw new Error("token server returned no token");
  return token;
}

async function applyAudioPrefs(dev, prefs) {
  if (!prefs || (!prefs.micId && !prefs.speakerId)) return;
  let micId = prefs.micId;
  let speakerId = prefs.speakerId;
  try {
    // saved deviceIds go stale across reboots — re-resolve by label
    const list = await navigator.mediaDevices.enumerateDevices();
    const reResolve = (devices, savedId, savedLabel) => {
      if (!savedId || devices.some((d) => d.deviceId === savedId)) return savedId;
      const byLabel = devices.find(
        (d) => d.label && savedLabel && d.label.toLowerCase().includes(savedLabel.toLowerCase())
      );
      return byLabel ? byLabel.deviceId : "";
    };
    micId = reResolve(list.filter((d) => d.kind === "audioinput"), prefs.micId, prefs.micLabel);
    speakerId = reResolve(list.filter((d) => d.kind === "audiooutput"), prefs.speakerId, prefs.speakerLabel);
  } catch (_) {
    /* enumeration failed — attempt the saved ids as-is */
  }
  try {
    if (micId && dev.audio?.setInputDevice) await dev.audio.setInputDevice(micId);
    if (speakerId && dev.audio?.speakerDevices?.set) await dev.audio.speakerDevices.set(speakerId);
  } catch (err) {
    statusPatch({ state: "error", error: `[engine] audio device switch failed — ${String(err.message ?? err)}` });
  }
}

async function initDevice() {
  if (device && deviceMintedAt && Date.now() - deviceMintedAt > TOKEN_TTL_MS) {
    await destroyDevice();
  }
  if (device) return device;
  const base = await getSetting("serverBase", "http://localhost:3001");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    statusPatch({ state: "error", error: "[engine] Microphone blocked — allow it for this extension in Chrome settings." });
    throw err;
  }
  const token = await tokenFetch(base);
  device = new Twilio.Device(token, { codecPreferences: ["pcmu", "opus"], logLevel: "warn" });
  deviceMintedAt = Date.now();
  device.on("error", (err) => {
    // 20104 = AccessTokenExpired — drop the device so the next dial re-mints
    if (err?.code === 20104) void destroyDevice();
    statusPatch({ state: "error", error: `[engine] ${String(err.message ?? err)}` });
  });
  statusPatch({ state: "ready" });
  return device;
}

let dialInFlight = false;
let generation = 0;

async function dial(to, callerId, micId, micLabel, speakerId, speakerLabel) {
  cancelPending();
  if (dialInFlight || activeCall) return;
  dialInFlight = true;
  let call = null;
  try {
    statusPatch({ state: "dialing", to });
    const dev = await initDevice();
    await applyAudioPrefs(dev, { micId, micLabel, speakerId, speakerLabel });
    statusPatch({ state: "ringing", to });
    const connectParams = { To: to };
    if (callerId) connectParams.CallerId = callerId;
    call = await dev.connect({ params: connectParams });
    activeCall = call;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (activeCall === call) { activeCall = null; connectedAt = null; }
      statusPatch({ state: "idle" });
    };
    call.on("accept", () => {
      connectedAt = Date.now();
      statusPatch({ state: "connected", to, connectedAt });
    });
    call.on("disconnect", done);
    call.on("cancel", done);
    call.on("reject", done);
    call.on("error", (err) => {
      if (finished) return;
      finished = true;
      if (activeCall === call) { activeCall = null; connectedAt = null; }
      statusPatch({ state: "error", error: String(err.message ?? err) });
    });
  } catch (err) {
    if (activeCall === call) activeCall = null;
    statusPatch({ state: "error", error: `[engine] ${String(err.message ?? err)}` });
  } finally {
    dialInFlight = false;
  }
}

function cancelPending() { generation++; }

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "dial") {
    void dial(msg.to, msg.callerId, msg.micId, msg.micLabel, msg.speakerId, msg.speakerLabel);
  } else if (msg.type === "hangup") {
    cancelPending();
    try { activeCall?.disconnect(); } catch (_) {}
    try { device?.disconnectAll(); } catch (_) {}
    activeCall = null; connectedAt = null;
    statusPatch({ state: "idle" });
  } else if (msg.type === "digits" && activeCall) {
    activeCall.sendDigits(msg.digits);
  } else if (msg.type === "mute" && activeCall) {
    activeCall.mute(Boolean(msg.value));
  } else if (msg.type === "setAudio" && device) {
    void applyAudioPrefs(device, { micId: msg.micId, micLabel: msg.micLabel, speakerId: msg.speakerId, speakerLabel: msg.speakerLabel });
  } else if (msg.type === "status") {
    statusPatch({
      state: activeCall ? (connectedAt ? "connected" : "ringing") : "idle",
      connectedAt: connectedAt ?? null,
      to: activeCall?.parameters?.To ?? null,
    });
  }
});

statusPatch({ state: "idle" });
