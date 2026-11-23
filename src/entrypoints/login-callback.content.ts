/*
 * Synchrothek – Rückkehr der Anmeldung auf https://app.synchrothek.de/extension/verbunden
 *
 * Liest die Antwort der Plattform (`code`, `state`, `iss` bzw. `error`) selbst aus der Adresse des Tabs –
 * nicht aus Nachrichten der Seite – und gibt sie an den Hintergrund. Der prüft Absender, Tab und State
 * und löst den Code mit dem PKCE-Verifier ein (src/lib/login-flow.ts). Tokens kommen hier nie an.
 *
 * Der Seite meldet das Skript nur den Zustand über Attribute am <html>-Element (keine Daten):
 * `received` (Antwort gelesen, die Seite darf sie aus der Adresse entfernen), danach `done` oder `error`
 * mit der Fehlerart.
 */
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { AUTH_CALLBACK_MATCH, AUTH_CALLBACK_URL } from '../lib/config';
import {
  LOGIN_CALLBACK_MESSAGE,
  LOGIN_ERROR_ATTRIBUTE,
  LOGIN_ERROR_KINDS,
  LOGIN_STATUS_ATTRIBUTE,
  parseCallbackParams,
  type LoginCallbackMessage,
  type LoginErrorKind,
} from '../lib/login-flow';

export default defineContentScript({
  matches: [AUTH_CALLBACK_MATCH],
  allFrames: false,
  runAt: 'document_start',
  // Keine ungefragte Nachricht an die Seite (siehe app-bridge.content.ts)
  noScriptStartedPostMessage: true,
  async main() {
    const here = new URL(location.href);
    const expected = new URL(AUTH_CALLBACK_URL);
    if (here.origin !== expected.origin || here.pathname !== expected.pathname) return;
    const params = parseCallbackParams(here);
    if (params.code === null && params.error === null) return; // nichts zu übergeben (z. B. nach Neuladen)

    const root = document.documentElement;
    const show = (status: 'received' | 'done' | 'error', error?: LoginErrorKind) => {
      root.setAttribute(LOGIN_STATUS_ATTRIBUTE, status);
      if (error) root.setAttribute(LOGIN_ERROR_ATTRIBUTE, error);
      else root.removeAttribute(LOGIN_ERROR_ATTRIBUTE);
    };

    const message: LoginCallbackMessage = { type: LOGIN_CALLBACK_MESSAGE, ...params };
    const sent = browser.runtime.sendMessage(message);
    show('received');
    try {
      const result = (await sent) as { ok?: unknown; error?: unknown } | undefined;
      if (result?.ok === true) show('done');
      else show('error', LOGIN_ERROR_KINDS.includes(result?.error as LoginErrorKind) ? (result!.error as LoginErrorKind) : 'failed');
    } catch {
      show('error', 'failed'); // Hintergrund nicht erreichbar
    }
  },
});
