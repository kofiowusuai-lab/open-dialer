// Open Dialer → Google Sheets webhook (your sheet, your account).
//
// SETUP (about 2 minutes):
//   1. Open your Google Sheet (create one if needed).
//   2. Extensions → Apps Script. Delete the placeholder code and paste this in.
//   3. Deploy → New deployment → type "Web app":
//        - Execute as: Me
//        - Who has access: Anyone
//      Deploy and copy the /exec URL.
//   4. In the Open Dialer extension → Settings → paste the URL under
//      "Sheet webhook URL" → Save.
//   5. Optional: in the Leads tab click "Test sheet connection" once. The
//      header row is created automatically.
//
// Every dialed outcome appends one row. Extra CSV columns from your leads
// file are also written back if you add matching headers manually.

const HEADERS = [
  "dialed_at", "phone", "name", "company", "outcome", "notes",
  "duration_sec",
];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

    // create header row if the sheet is empty
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
    }

    if (data.test === true) {
      // connection test — just make sure headers exist, no extra row
      return ContentService.createTextOutput(JSON.stringify({ ok: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const row = HEADERS.map((h) => data[h] ?? "");
    // append any extra columns from the lead import
    const headers = HEADERS.slice();
    if (data.extra && typeof data.extra === "object") {
      for (const [k, v] of Object.entries(data.extra)) {
        if (headers.indexOf(k) === -1) headers.push(k);
        row.push(v ?? "");
      }
      // keep header row in sync with any new extra columns
      if (headers.length > HEADERS.length) {
        const headerRange = sheet.getRange(1, 1, 1, sheet.getLastColumn());
        const existing = headerRange.getValues()[0];
        if (existing.join(",") !== headers.join(",")) {
          headerRange.clearContent();
          sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        }
      }
    }
    sheet.appendRow(row);

    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
