# Open Dialer

Open-source power dialer browser extension for Chrome. Import leads from a CSV,
auto-dial through your queue using **your own Twilio account**, log outcomes
back to **your own Google Sheet**. No third-party infrastructure, no telemetry,
no accounts — your Twilio secrets stay on your machine.

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
        │ POST outcomes
        ▼
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
- The extension talks to exactly two places: your local token server and (optionally) your own sheet webhook.
- Nothing is logged, tracked, or sent anywhere else. Audit the code — it's ~600 readable lines.

## Known limitations (by design)

- One caller at a time, one browser. This is a personal power dialer, not a call center.
- Outcomes go to a single sheet/local store — there is intentionally **no CRM**.
- Calls are billed to your Twilio account; check local regulations (TCPA/DNC etc.) before dialing.

## License

MIT — do whatever you want, attribution not required. See [LICENSE](LICENSE).
