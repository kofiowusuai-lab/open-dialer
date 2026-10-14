# Open Dialer

Open-source power dialer browser extension for Chrome. Import leads from a CSV,
auto-dial through your queue using **your own Twilio account**, log outcomes
back to **your own Google Sheet**. No application account or maintainer-hosted service is required. Twilio handles
voice calls; optional Google Apps Script handles spreadsheet logging. Your Twilio
API signing secret stays in your local server configuration.

## How it fits together

```
┌─────────────────┐      WebRTC call audio      ┌──────────────────┐
│ Chrome extension │ ─────────────────────────► │  Twilio (voice)  │
│  (Open Dialer)   │    via Twilio Voice SDK     └──────────────────┘
└───────┬─────────┘
        │ GET /token (short-lived Voice token)
        ▼
┌─────────────────────────────────────────────┐
│ Token server (runs locally, zero deps)      │  ← your Twilio API keys
│ node server.js                              │    live HERE, in .env
└─────────────────────────────────────────────┘

Chrome side panel sends POST outcomes to:
┌─────────────────────────────────────────────┐
│ Your Google Sheet (via Apps Script webhook) │  ← your data, your account
└─────────────────────────────────────────────┘
```

## What you need

1. A [Twilio](https://www.twilio.com) account with a phone number that can make outbound calls.
2. Node.js 18+ (for the tiny local token server).
3. Chrome (the extension uses side panels + offscreen documents).
4. A Google Sheet (optional — outcomes are also saved locally and exportable as CSV).

## Setup

### 1. Twilio credentials

In the Twilio Console:

- **API Key**: Console → Account → API keys & tokens → create a key. Note the SID (`SK...`) and Secret.
- **TwiML App**: Console → Voice → TwiML Apps → create one. Set its **voice REQUEST URL** to a Twilio Function
  containing the code from [`server/twiml-app/function-sample.js`](server/twiml-app/function-sample.js) (see comments in that file).
- Note the TwiML App SID (`AP...`).

### 2. Run the token server

```bash
cd server
cp .env.example .env
# edit .env with your Account SID, API key SID/secret, caller ID, TwiML App SID
node server.js
```

It listens on `http://localhost:3001` (configurable via `PORT`).

### 3. Load the extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Click the toolbar icon to open the dialer panel.

### 4. Configure the extension

Open the panel → **Settings** tab:

| Setting | What it does |
|---|---|
| **Token server URL** | Where the extension gets its call tokens — default `http://localhost:3001`. Use **Test connection** to verify. |
| **Caller ID** | Your Twilio number calls come from (blank = the server's default). |
| **Sheet webhook URL** | Your Google Sheet's Apps Script URL (below). Blank = local only. |
| **Grace period between calls** | Seconds to pause after each call so you can enter data before auto-dial resumes. |
| **Ring timeout** | Seconds to let a call ring before treating it as no-answer and moving on. |
| **Default country code** | Used to expand 10-digit numbers to E.164. |
| **Audio devices** | Pick your mic and speaker/headphones. |

### 5. Connect your spreadsheet (optional)

1. Open your Google Sheet → **Extensions → Apps Script**.
2. Paste the code from [`sheets-webhook/apps-script.gs`](sheets-webhook/apps-script.gs).
3. **Deploy → New deployment → Web app** (Execute as: Me, Access: Anyone). Copy the `/exec` URL.
4. Paste it into the extension's **Settings → Sheet webhook URL** and save.

Each completed call appends a row: `dialed_at, phone, name, company, outcome, notes, duration_sec`, plus any extra columns from your CSV.

## Using the dialer

1. **Leads tab** → import a CSV. Required column: `phone` (or `mobile`/`number`). Optional: `name`, `company`, `notes`. Extra columns are preserved and written to your sheet.
2. **Dialer tab** → press **Call** for a single call, or **Start →** to auto-dial the whole queue. After each call an outcome panel appears: pick a disposition, type notes, **Save & continue** — then the grace period runs and the next lead dials.
3. **Leads tab** → download all results as CSV any time, or let the webhook push them to your sheet as you go.

Dispositions: `connected`, `callback`, `not-interested`, `no-answer`, `voicemail`, `bad-number`, `dnc`.

## Security model

- Twilio API keys live **only** in `server/.env` on your machine — never in the browser, never in any cloud service.
- Tokens are short-lived (1 hour) and minted on demand.
- The extension uses the local token server, Twilio Voice services, and optionally the Google Apps Script webhook. Call destination and voice traffic reach Twilio; saved outcomes reach Google when configured.
- Queue/results use `chrome.storage.local`. Settings use `chrome.storage.sync`, which can sync through the signed-in Chrome profile. The code includes no analytics integration.
- The token server calls `listen(PORT)` without a loopback-only host, allows wildcard CORS, and has no token-endpoint authentication. Keep it on a trusted machine/network; the current implementation is not hardened for public hosting.
- The Apps Script sample is deployed with Anyone access and contains no webhook authentication. Treat its URL as sensitive; it is not an access-controlled logging API.

## Known limitations (by design)

- One caller at a time, one browser. This is a personal power dialer, not a call center.
- Outcomes go to a single sheet/local store — there is intentionally **no CRM**.
- Calls are billed to your Twilio account; check local regulations (TCPA/DNC etc.) before dialing.

## License

MIT. Preserve the copyright and permission notice when distributing copies or substantial portions. See [LICENSE](LICENSE).

## Configuration reference

The local server loads `server/.env` itself. Existing process environment values
win over that file. All five Twilio variables below are required at startup:

| Variable | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio account used in voice-token claims |
| `TWILIO_API_KEY_SID` | Key identifying the token signer |
| `TWILIO_API_KEY_SECRET` | Secret used to sign access tokens |
| `TWILIO_CALLER_ID` | Outbound phone number and health-response default |
| `TWILIO_TWIML_APP_SID` | Application receiving outgoing call requests |
| `PORT` | Local HTTP port; defaults to 3001 |

The Twilio Function also needs its own `TWILIO_CALLER_ID` configuration as the
fallback when a call does not supply an override. Creating a local `.env` does
not configure a hosted Twilio Function.

## Source walkthrough and artifacts

- [`extension/manifest.json`](extension/manifest.json) declares Manifest V3 permissions and the permitted localhost/Google webhook origins.
- [`extension/background.js`](extension/background.js) opens the side panel and coordinates the offscreen call document.
- [`extension/offscreen.js`](extension/offscreen.js) fetches a voice token and operates the bundled Twilio SDK/audio connection.
- [`extension/sidepanel.js`](extension/sidepanel.js) parses CSV leads, normalizes numbers, manages call/disposition state, stores the queue, and exports outcomes.
- [`server/server.js`](server/server.js) uses Node built-ins to serve `/health` and sign one-hour `/token` responses; no npm install is needed.
- [`server/twiml-app/function-sample.js`](server/twiml-app/function-sample.js) validates the destination format and returns TwiML for dialing.
- [`sheets-webhook/apps-script.gs`](sheets-webhook/apps-script.gs) appends outcomes to the active sheet and maintains extra headers.

An import needs a header row and at least one valid lead. A synthetic example:

```csv
phone,name,company,notes
+12025550123,Example Contact,Example Company,Demo row
```

CSV exports are named `dialer-results-YYYY-MM-DD.csv`. Browser storage holds the
queue, results, and cursor; exported files and sheet rows contain lead data.
Use a consistent set/order of extra CSV columns when logging to one sheet: the
sample updates headers from each submitted outcome rather than implementing a
schema migration or deduplicating repeated submissions.

## Local verification and troubleshooting

There is no package manifest, build step, or automated test suite. Syntax checks:

```bash
node --check server/server.js
node --check extension/background.js
node --check extension/offscreen.js
node --check extension/sidepanel.js
node --check server/twiml-app/function-sample.js
```

With the configured server running, visit `http://localhost:3001/health` and use
**Test connection** in settings. Then load/reload the extension and test CSV
import, microphone permission, a manually approved call, outcome saving, and CSV
export. A successful health response only proves the local server is running;
it does not verify Twilio account permissions or the hosted TwiML handler.

Missing environment errors identify the unset variable. If calls fail, verify the
TwiML application URL, caller ID, Twilio account restrictions, microphone access,
and audio devices. A custom remote token URL is not supported by the current
manifest's host permissions. For sheet failures, verify the deployed `/exec` URL
and Apps Script authorization; HTTP success alone may still contain `ok: false`
in the sample webhook's JSON response. Keep local CSV export as the recovery path.
