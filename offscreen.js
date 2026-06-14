"use strict";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    !message ||
    message.target !== "offscreen" ||
    message.type !== "COPY_TO_CLIPBOARD"
  ) {
    return;
  }

  (async () => {
    try {
      await navigator.clipboard.writeText(message.text || "");
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err),
      });
    }
  })();

  return true;
});
