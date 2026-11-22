/*
 * Synchrothek – Versionsabfrage auf app.synchrothek.de
 * Antwortet auf „Hilfe & Kontakt“ mit Version und Browser der Extension (sonst nichts).
 * Handshake wie von der offiziellen Plattform vorgegeben (siehe src/lib/app-bridge.ts).
 */
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { answerFor } from '../lib/app-bridge';
import { APP_MATCH } from '../lib/config';

export default defineContentScript({
  matches: [APP_MATCH],
  allFrames: false,
  runAt: 'document_start',
  // WXT schickt sonst beim Start ungefragt eine Nachricht an '*' (Erkennung alter Skript-Instanzen).
  // Die Seite darf aber nur auf ihre Anfrage hin etwas von der Extension hören.
  noScriptStartedPostMessage: true,
  main(ctx) {
    const info = {
      version: browser.runtime.getManifest().version,
      browser: import.meta.env.FIREFOX ? ('firefox' as const) : ('chrome' as const),
    };
    // Nur auf Anfrage der Seite antworten, nie ungefragt, nie an '*'
    ctx.addEventListener(window, 'message', (event) => {
      const answer = answerFor(event, window, location.origin, info);
      if (answer) window.postMessage(answer, location.origin);
    });
  },
});
