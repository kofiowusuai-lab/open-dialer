// Open Dialer — MV3 service worker.
// Routes messages between the side panel (UI) and the offscreen document
// (Twilio Voice SDK WebRTC engine) so calls survive panel close.
// All credentials and configuration live in chrome.storage — nothing phones
// home to any third party. Users connect their own Twilio account via a
// self-hosted token server (see /server in the repo).

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Twilio Voice SDK WebRTC call audio",
  });
}

let booting = null;
async function bootEngine() {
  if (!booting) {
    booting = (async () => {
      if (!(await hasOffscreen())) {
        await ensureOffscreen();
        await new Promise((r) => setTimeout(r, 300));
      }
    })().finally(() => {
      booting = null;
    });
  }
  await booting;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.target === "offscreen") {
      await bootEngine();
      await chrome.runtime.sendMessage(msg);
      sendResponse({ ok: true });
    }
  })().catch((error) => sendResponse({ ok: false, error: String(error.message ?? error) }));
  return true;
});
