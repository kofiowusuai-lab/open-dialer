// Open Dialer side panel — dialer UI, CSV lead queue, auto-dial, outcomes,
// settings. Queue + outcomes persist in chrome.storage.local (user's machine).
// Call engine lives in the offscreen document; Twilio secrets live only in the
// user's self-hosted token server.

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  serverBase: "http://localhost:3001",
  callerId: "",
  webhookUrl: "",
  graceSec: 30,
  ringSec: 30,
  country: "+1",
};

let cfg = { ...DEFAULTS };

// ---------- persistent state ----------
let queue = [];        // [{ id, phone, name, company, notes, ...extra }]
let results = [];      // [{ id, phone, name, company, outcome, notes, at, durationSec }]
let cursor = 0;        // index of next lead
let autoDial = false;
let callState = "idle";
let startedAt = null;
let timerHandle = null;
let muted = false;
let graceUntil = 0;
let ringDeadline = 0;
let currentCall = null; // { lead, phone, pickedUp }
let pendingOutcome = null;

async function loadState() {
  const stored = await chrome.storage.local.get(["queue", "results", "cursor"]);
  queue = stored.queue ?? [];
  results = stored.results ?? [];
  cursor = stored.cursor ?? 0;
}

let saveTimer = null;
function persistState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({ queue, results, cursor });
  }, 250);
}

async function loadCfg() {
  const stored = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  cfg = { ...DEFAULTS, ...stored };
  $("serverBase").value = cfg.serverBase;
  $("callerId").value = cfg.callerId;
  $("webhookUrl").value = cfg.webhookUrl;
  $("graceSec").value = cfg.graceSec;
  $("ringSec").value = cfg.ringSec;
  $("country").value = cfg.country;
  $("graceNote").textContent = cfg.graceSec > 0
    ? `Grace period: ${cfg.graceSec}s between calls for data entry`
    : "Grace period: none — next call dials immediately";
}

// ---------- tabs ----------
function showView(name) {
  for (const v of ["Dial", "Leads", "Settings"]) {
    $(`view${v}`).classList.toggle("on", v === name);
    $(`tab${v}`).classList.toggle("on", v === name);
  }
}
$("tabDial").addEventListener("click", () => showView("Dial"));
$("tabLeads").addEventListener("click", () => showView("Leads"));
$("tabSettings").addEventListener("click", () => showView("Settings"));

// ---------- tones (local, gesture-permitted) ----------
let audioCtx = null;
function actx() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
const DTMF = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477],
};
function playDtmf(key) {
  const f = DTMF[key];
  if (!f) return;
  const c = actx();
  const g = c.createGain();
  g.gain.value = 0.12;
  g.connect(c.destination);
  f.forEach((freq) => {
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.value = freq;
    o.connect(g);
    o.start();
    o.stop(c.currentTime + 0.15);
  });
}
let ringback = null;
function startRingback() {
  if (ringback) return;
  const c = actx();
  const g = c.createGain();
  g.gain.value = 0;
  g.connect(c.destination);
  const o1 = c.createOscillator(); o1.frequency.value = 440;
  const o2 = c.createOscillator(); o2.frequency.value = 480;
  o1.connect(g); o2.connect(g);
  const ring = () => {
    const now = c.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.07, now + 0.02);
    g.gain.setValueAtTime(0.07, now + 1.98);
    g.gain.linearRampToValueAtTime(0, now + 2);
  };
  o1.start(); o2.start(); ring();
  const timer = setInterval(ring, 6000);
  ringback = { o1, o2, timer };
}
function stopRingback() {
  if (!ringback) return;
  clearInterval(ringback.timer);
  try { ringback.o1.stop(); ringback.o2.stop(); } catch (_) {}
  ringback = null;
}

// ---------- waveform ----------
(function buildWave() {
  const wave = $("wave");
  for (let i = 0; i < 32; i++) {
    const span = document.createElement("span");
    span.style.height = `${25 + Math.abs(Math.sin(i * 1.7)) * 70}%`;
    span.style.animationDelay = `${(i % 12) * 0.08}s`;
    wave.appendChild(span);
  }
})();

// ---------- status / timer ----------
function status(text, isError = false) {
  $("status").textContent = text;
  $("status").className = "status-line" + (isError ? " err" : "");
  $("micFixBtn").style.display = isError ? "" : "none";
}

function startTimer(epoch = Date.now()) {
  startedAt = epoch;
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    $("timer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
}
function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
  startedAt = null;
}

function setLive(state, to) {
  callState = state;
  const dot = $("liveDot");
  const text = $("liveText");
  const timer = $("timer");
  dot.className = "live-dot" + (state === "connected" ? " on" : state === "error" ? " err" : "");
  if (state === "connected") {
    text.textContent = "LIVE CALL";
    timer.classList.add("live");
    $("wave").classList.add("live");
    $("muteBtn").disabled = false;
    $("endBtn").style.display = "";
  } else if (state === "ringing" || state === "dialing") {
    text.textContent = "DIALING";
    timer.classList.add("live");
    $("wave").classList.add("live");
    $("endBtn").style.display = "";
  } else {
    text.textContent = "READY";
    timer.classList.remove("live");
    $("wave").classList.remove("live");
    $("muteBtn").disabled = true;
    $("endBtn").style.display = "none";
    timer.textContent = "00:00";
  }
  renderQueueUI();
}

// ---------- queue rendering ----------
function remaining() { return Math.max(0, queue.length - cursor); }

function renderQueueUI() {
  $("queueChip").innerHTML = `Queue: <b>${remaining()}</b> lead${remaining() === 1 ? "" : "s"} remaining &middot; <b>${results.length}</b> dialed`;
  $("qCount").textContent = String(remaining());
  $("qDone").textContent = `${results.length} dialed`;
  const list = $("qList");
  list.innerHTML = "";
  if (queue.length === 0) {
    list.innerHTML = `<div class="sub">No leads imported yet — add a CSV in the Leads tab.</div>`;
    return;
  }
  queue.forEach((lead, i) => {
    const tr = document.createElement("div");
    tr.className = "row";
    tr.style.cssText = "padding:5px 6px;border-top:1px solid var(--line);font-size:12px;";
    const done = i < cursor;
    const current = i === cursor;
    const outcome = results.find((r) => r.id === lead.id);
    const tag = outcome
      ? `<span class="pill">${escapeHtml(outcome.outcome ?? "dialed")}</span>`
      : current && (callState === "ringing" || callState === "connected")
        ? `<span class="pill ok">calling&hellip;</span>`
        : "";
    tr.innerHTML = `
      <div class="grow">
        <div>${escapeHtml(lead.name || lead.phone)}${lead.company ? ` <span class="muted">· ${escapeHtml(lead.company)}</span>` : ""}</div>
        <div class="muted">${escapeHtml(lead.phone)}</div>
      </div>
      ${tag}`;
    list.appendChild(tr);
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- CSV import ----------
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function normalizePhone(raw, countryDial) {
  const cleaned = String(raw ?? "").trim();
  const digits = cleaned.replace(/[^\d]/g, "");
  if (!digits) return null;
  if (cleaned.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `${countryDial}${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return null;
}

$("csvPick").addEventListener("click", () => $("csvFile").click());
$("csvFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    $("csvStatus").textContent = "CSV needs a header row plus at least one lead.";
    $("csvStatus").className = "status-line err";
    return;
  }
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const phoneIdx = headers.findIndex((h) => ["phone", "mobile", "number", "phone_number", "telephone", "tel"].includes(h));
  if (phoneIdx === -1) {
    $("csvStatus").textContent = `No phone column found. Columns seen: ${headers.join(", ")}. Rename one to "phone".`;
    $("csvStatus").className = "status-line err";
    return;
  }
  const nameIdx = headers.findIndex((h) => ["name", "full_name", "fullname", "contact", "first_name"].includes(h));
  const companyIdx = headers.findIndex((h) => ["company", "company_name", "organization", "org", "business"].includes(h));
  const notesIdx = headers.findIndex((h) => ["notes", "note", "comment", "comments"].includes(h));

  let added = 0;
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const phone = normalizePhone(cells[phoneIdx], cfg.country);
    if (!phone) { skipped++; continue; }
    const lead = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      phone,
      name: nameIdx >= 0 ? (cells[nameIdx] ?? "").trim() : "",
      company: companyIdx >= 0 ? (cells[companyIdx] ?? "").trim() : "",
      notes: notesIdx >= 0 ? (cells[notesIdx] ?? "").trim() : "",
    };
    // keep extra columns for write-back to the sheet
    lead.extra = {};
    headers.forEach((h, i) => {
      if (![phoneIdx, nameIdx, companyIdx, notesIdx].includes(i)) lead.extra[h] = (cells[i] ?? "").trim();
    });
    queue.push(lead);
    added++;
  }
  persistState();
  renderQueueUI();
  $("csvStatus").textContent = `Imported ${added} lead${added === 1 ? "" : "s"}${skipped ? ` — skipped ${skipped} row(s) with invalid numbers` : ""}.`;
  $("csvStatus").className = "status-line";
  e.target.value = "";
});

$("csvClear").addEventListener("click", () => {
  if (queue.length > 0 && !confirm("Clear the entire queue and all results?")) return;
  queue = []; results = []; cursor = 0;
  persistState();
  renderQueueUI();
});

// ---------- export ----------
function toCsv(rows) {
  if (rows.length === 0) return "";
  const cols = new Set(["phone", "name", "company", "outcome", "notes", "dialed_at", "duration_sec"]);
  for (const r of rows) for (const k of Object.keys(r.extra ?? {})) cols.add(k);
  const header = [...cols];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(header.map((c) => esc(r[c] ?? r.extra?.[c] ?? "")).join(","));
  }
  return lines.join("\n");
}

$("exportCsv").addEventListener("click", () => {
  if (results.length === 0) {
    $("exportStatus").textContent = "No results yet — dial some leads first.";
    return;
  }
  const blob = new Blob([toCsv(results)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dialer-results-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  $("exportStatus").textContent = `Exported ${results.length} result(s).`;
});

$("testWebhook").addEventListener("click", async () => {
  const url = $("webhookUrl").value.trim();
  if (!url) { $("exportStatus").textContent = "Set a webhook URL in Settings first."; return; }
  $("exportStatus").textContent = "Testing…";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ test: true }),
    });
    $("exportStatus").textContent = res.ok ? "Sheet connection works." : `Webhook returned ${res.status}.`;
  } catch (err) {
    $("exportStatus").textContent = `Failed — ${String(err.message ?? err)}`;
  }
});

// ---------- dialing ----------
async function ensureMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    void populateDevices();
    return true;
  } catch (_) {
    setLive("idle");
    status("Microphone needed — click Call again and press Allow. If no prompt appears, open Mic help.", true);
    return false;
  }
}

async function dialNumber(to, lead = null) {
  if (!(await ensureMic())) return;
  hideOutcome();
  stopRingback();
  playDtmf(to[0] ?? "0");
  startRingback();
  setLive("ringing", to);
  $("lblPerson").textContent = "Dialing";
  $("fPerson").innerHTML = lead
    ? `${escapeHtml(lead.name || "—")}<br><span class="muted">${escapeHtml(to)}${lead.company ? " · " + escapeHtml(lead.company) : ""}</span>`
    : escapeHtml(to);
  currentCall = { lead, phone: to, pickedUp: false, startedAt: Date.now() };
  status(`Ringing ${to}…`);
  ringDeadline = Date.now() + cfg.ringSec * 1000;
  try {
    const { micId = "", speakerId = "", micLabel = "", speakerLabel = "" } =
      await chrome.storage.sync.get(["micId", "speakerId", "micLabel", "speakerLabel"]);
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "dial",
      to,
      callerId: cfg.callerId || null,
      micId, micLabel, speakerId, speakerLabel,
    });
  } catch (err) {
    stopRingback();
    stopTimer();
    setLive("idle");
    status(`Could not reach call engine — ${String(err.message ?? err)}`, true);
  }
}

function normalizeTo(raw) {
  return normalizePhone(raw, cfg.country);
}

$("callBtn").addEventListener("click", () => {
  const to = normalizeTo($("num").value);
  if (!to) {
    status("Enter a full number with country code, e.g. +14155551234", true);
    return;
  }
  void dialNumber(to);
});

$("endBtn").addEventListener("click", () => {
  stopRingback();
  chrome.runtime.sendMessage({ target: "offscreen", type: "hangup" });
});

$("muteBtn").addEventListener("click", () => {
  if (callState !== "connected") return;
  muted = !muted;
  chrome.runtime.sendMessage({ target: "offscreen", type: "mute", value: muted });
  $("muteBtn").textContent = muted ? "🔇 Unmute" : "🎙 Mute";
});

// ---------- keypad ----------
const KEYS = [
  ["1", ""], ["2", "ABC"], ["3", "DEF"],
  ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
  ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
  ["*", ""], ["0", "+"], ["#", ""],
];
(function buildKeypad() {
  const grid = $("keypad");
  for (const [k, sub] of KEYS) {
    const b = document.createElement("button");
    b.innerHTML = `${k}<small>${sub}</small>`;
    b.addEventListener("click", () => {
      playDtmf(k);
      if (callState === "connected") {
        chrome.runtime.sendMessage({ target: "offscreen", type: "digits", digits: k });
        return;
      }
      if (($("num").value ?? "").length < 18) $("num").value += k;
    });
    grid.appendChild(b);
  }
})();
$("keypadBtn").addEventListener("click", () => $("keypad").classList.toggle("open"));

// ---------- auto-dial loop ----------
$("autoBtn").addEventListener("click", () => {
  autoDial = !autoDial;
  $("autoBtn").innerHTML = autoDial ? "Stop &#9632;" : "Start &#8594;";
  if (autoDial) status("Auto-dial on — starting with the next lead in the queue.");
  else status("Auto-dial stopped.");
});

setInterval(async () => {
  // ring timeout: mark no-answer and end the call
  if (callState === "ringing" && ringDeadline && Date.now() > ringDeadline) {
    ringDeadline = 0;
    if (currentCall) currentCall.timedOut = true;
    chrome.runtime.sendMessage({ target: "offscreen", type: "hangup" });
  }
  if (!autoDial || callState !== "idle" || pendingOutcome) return;
  if (Date.now() < graceUntil) return;
  if (cursor >= queue.length) {
    if (remaining() === 0 && results.length > 0 && $("status").textContent !== "Queue complete.") {
      status("Queue complete.");
    }
    return;
  }
  const lead = queue[cursor];
  void dialNumber(lead.phone, lead);
}, 1500);

// ---------- outcomes ----------
const DISPOSITIONS = {
  yes: [
    ["connected", "Connected — interested"],
    ["callback", "Connected — callback later"],
    ["not-interested", "Connected — not interested"],
    ["dnc", "Do not call"],
  ],
  no: [
    ["no-answer", "No answer"],
    ["voicemail", "Voicemail"],
    ["bad-number", "Bad number"],
    ["dnc", "Do not call"],
  ],
};

function showOutcome(call) {
  if (!call) return;
  const lead = call.lead;
  const who = lead ? (lead.name || lead.phone) : call.phone;
  const company = lead?.company;
  $("ocWho").textContent = company ? `${who} · ${company}` : who;
  $("ocYes").classList.add("on");
  $("ocNo").classList.remove("on");
  fillDisposition("yes");
  $("ocNotes").value = lead?.notes ?? "";
  $("ocStatus").style.display = "none";
  $("outcomePanel").style.display = "";
  pendingOutcome = call;
}

function fillDisposition(kind) {
  const sel = $("ocDisposition");
  sel.innerHTML = "";
  for (const [value, label] of DISPOSITIONS[kind]) sel.add(new Option(label, value));
}

function hideOutcome() {
  $("outcomePanel").style.display = "none";
  pendingOutcome = null;
}

$("ocYes").addEventListener("click", () => {
  $("ocYes").classList.add("on");
  $("ocNo").classList.remove("on");
  fillDisposition("yes");
});
$("ocNo").addEventListener("click", () => {
  $("ocNo").classList.add("on");
  $("ocYes").classList.remove("on");
  fillDisposition("no");
});

$("ocSave").addEventListener("click", async () => {
  if (!pendingOutcome) return;
  const call = pendingOutcome;
  const outcome = $("ocDisposition").value;
  const notes = $("ocNotes").value.trim();
  const durationSec = call.connectedAt ? Math.round((call.endedAt ?? Date.now()) - call.connectedAt) / 1000 : 0;
  const result = {
    id: call.lead?.id ?? `${Date.now()}`,
    phone: call.phone,
    name: call.lead?.name ?? "",
    company: call.lead?.company ?? "",
    outcome,
    notes,
    dialed_at: new Date(call.startedAt).toISOString(),
    duration_sec: Math.round(durationSec),
    extra: call.lead?.extra ?? {},
  };
  results.push(result);
  if (call.lead) cursor = Math.max(cursor, queue.findIndex((l) => l.id === call.lead.id) + 1);
  persistState();
  renderQueueUI();
  hideOutcome();
  $("ocStatus").style.display = "";
  $("ocStatus").textContent = "Saved.";
  await pushToSheet(result);
  graceUntil = Date.now() + cfg.graceSec * 1000;
  status(cfg.graceSec > 0 ? `Saved — next call in ${cfg.graceSec}s.` : "Saved — dialing next…");
});

$("ocSkip").addEventListener("click", () => {
  if (!pendingOutcome) return;
  const call = pendingOutcome;
  if (call.lead) cursor = Math.max(cursor, queue.findIndex((l) => l.id === call.lead.id) + 1);
  persistState();
  renderQueueUI();
  hideOutcome();
  graceUntil = Date.now() + cfg.graceSec * 1000;
});

async function pushToSheet(result) {
  const url = cfg.webhookUrl;
  if (!url) return;
  try {
    // text/plain avoids a CORS preflight against Apps Script
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(result),
    });
  } catch (err) {
    $("ocStatus").textContent = `Saved locally — sheet sync failed (${String(err.message ?? err)})`;
  }
}

// ---------- messages from engine ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "popup-status") return;
  if (msg.state === "dialing") {
    setLive("ringing", msg.to);
  } else if (msg.state === "ringing") {
    if (!ringback) startRingback();
    setLive("ringing", msg.to);
  } else if (msg.state === "connected") {
    stopRingback();
    ringDeadline = 0;
    if (currentCall) currentCall.pickedUp = true;
    if (!timerHandle) startTimer(msg.connectedAt ?? Date.now());
    setLive("connected", msg.to);
    $("lblPerson").textContent = "On the line";
    status(`Connected ${msg.to ?? ""}`);
  } else if (msg.state === "error") {
    stopRingback();
    stopTimer();
    setLive("idle");
    status(msg.error ?? "error", true);
    currentCall = null;
  } else if (msg.state === "idle") {
    stopRingback();
    stopTimer();
    setLive("idle");
    const justEnded = currentCall;
    currentCall = null;
    if (justEnded) {
      justEnded.endedAt = Date.now();
      if (autoDial || results.length > 0 || justEnded.lead) showOutcome(justEnded);
    }
    status("idle");
  }
});

// ---------- settings wiring ----------
$("saveTwilio").addEventListener("click", async () => {
  cfg.serverBase = ($("serverBase").value.trim().replace(/\/$/, "") || DEFAULTS.serverBase);
  cfg.callerId = $("callerId").value.trim();
  await chrome.storage.sync.set({ serverBase: cfg.serverBase, callerId: cfg.callerId });
  $("serverStatus").textContent = "Saved.";
});
$("testServer").addEventListener("click", async () => {
  const base = $("serverBase").value.trim().replace(/\/$/, "") || DEFAULTS.serverBase;
  $("serverStatus").textContent = "Testing…";
  try {
    const res = await fetch(`${base}/health`);
    if (res.ok) {
      const info = await res.json().catch(() => ({}));
      $("serverStatus").textContent = `Connected. ${info.callerId ? `Default caller ID: ${info.callerId}` : "No default caller ID set."}`;
    } else {
      $("serverStatus").textContent = `Server responded ${res.status}.`;
    }
  } catch (err) {
    $("serverStatus").textContent = `Not reachable at ${base} — is the token server running? (repo: server/)`;
  }
});
$("saveWebhook").addEventListener("click", async () => {
  cfg.webhookUrl = $("webhookUrl").value.trim();
  await chrome.storage.sync.set({ webhookUrl: cfg.webhookUrl });
  $("serverStatus").textContent = "Webhook saved.";
});
$("saveTiming").addEventListener("click", async () => {
  cfg.graceSec = Math.max(0, Math.min(600, Number($("graceSec").value) || 0));
  cfg.ringSec = Math.max(10, Math.min(120, Number($("ringSec").value) || 30));
  cfg.country = $("country").value;
  await chrome.storage.sync.set({ graceSec: cfg.graceSec, ringSec: cfg.ringSec, country: cfg.country });
  $("graceNote").textContent = cfg.graceSec > 0
    ? `Grace period: ${cfg.graceSec}s between calls for data entry`
    : "Grace period: none — next call dials immediately";
  $("serverStatus").textContent = "Timing saved.";
});

// ---------- audio devices ----------
function fillDeviceSelect(sel, devices, chosen) {
  sel.innerHTML = "";
  sel.add(new Option("System default", ""));
  devices.forEach((d, i) =>
    sel.add(new Option(d.label || `${sel.id === "micSelect" ? "Microphone" : "Output"} ${i + 1}`, d.deviceId))
  );
  if (chosen && devices.some((d) => d.deviceId === chosen)) sel.value = chosen;
}

async function populateDevices() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const { micId = "", speakerId = "", micLabel = "", speakerLabel = "" } =
      await chrome.storage.sync.get(["micId", "speakerId", "micLabel", "speakerLabel"]);
    const reResolve = (devices, savedId, savedLabel) => {
      if (!savedId || devices.some((d) => d.deviceId === savedId)) return savedId;
      const byLabel = devices.find(
        (d) => d.label && savedLabel && d.label.toLowerCase().includes(savedLabel.toLowerCase())
      );
      return byLabel ? byLabel.deviceId : "";
    };
    const freshMicId = reResolve(list.filter((d) => d.kind === "audioinput"), micId, micLabel);
    const freshSpeakerId = reResolve(list.filter((d) => d.kind === "audiooutput"), speakerId, speakerLabel);
    if (freshMicId && freshMicId !== micId) await chrome.storage.sync.set({ micId: freshMicId });
    if (freshSpeakerId && freshSpeakerId !== speakerId) await chrome.storage.sync.set({ speakerId: freshSpeakerId });
    fillDeviceSelect($("micSelect"), list.filter((d) => d.kind === "audioinput"), freshMicId || micId);
    fillDeviceSelect($("speakerSelect"), list.filter((d) => d.kind === "audiooutput"), freshSpeakerId || speakerId);
  } catch (_) {}
}

$("micSelect").addEventListener("change", () => {
  chrome.storage.sync.set({ micId: $("micSelect").value, micLabel: $("micSelect").selectedOptions?.[0]?.label ?? "" });
  chrome.runtime.sendMessage({
    target: "offscreen", type: "setAudio",
    micId: $("micSelect").value, speakerId: $("speakerSelect").value,
  }).catch(() => {});
});
$("speakerSelect").addEventListener("change", () => {
  chrome.storage.sync.set({ speakerId: $("speakerSelect").value, speakerLabel: $("speakerSelect").selectedOptions?.[0]?.label ?? "" });
  chrome.runtime.sendMessage({
    target: "offscreen", type: "setAudio",
    micId: $("micSelect").value, speakerId: $("speakerSelect").value,
  }).catch(() => {});
});
navigator.mediaDevices.ondevicechange = () => void populateDevices();

$("micFixBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
});

// ---------- boot ----------
window.onerror = (msg, src, line) => {
  const el = $("status");
  if (el) { el.className = "status-line err"; el.textContent = `[panel] ${msg} (${(src ?? "").split("/").pop()}:${line})`; }
  return false;
};

(async () => {
  await loadCfg();
  await loadState();
  renderQueueUI();
  void populateDevices();
  setLive("idle");
  chrome.runtime.sendMessage({ target: "offscreen", type: "status" }).catch(() => {});
})();
