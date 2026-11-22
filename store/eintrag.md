# Store-Einträge (Chrome Web Store und addons.mozilla.org)

Texte und Angaben zum Kopieren. Pakete: `npm run zip` (Chrome) und `npm run zip:firefox` (Firefox-Paket und Quellen-ZIP) in `.output/`.

## Gemeinsam

- **Name:** Synchrothek
- **Kurzbeschreibung** (Chrome ≤ 132 Zeichen, = Manifest-`description`):
  Öffentlich-rechtliche Mediatheken gemeinsam schauen: Play, Pause und Position synchron – jede Person im offiziellen Player.
- **Website:** https://synchrothek.de
- **Support:** https://app.synchrothek.de/hilfe · contact@synchrothek.de
- **Datenschutzerklärung:** https://synchrothek.de/datenschutz
- **Quellcode:** https://github.com/Synchrothek/synchrothek (AGPL-3.0-only)
- **Sprache:** Deutsch

### Ausführliche Beschreibung

```
Mit Synchrothek schaut ihr Sendungen aus öffentlich-rechtlichen Mediatheken gemeinsam – auch wenn ihr an verschiedenen Orten seid. Unterstützt werden derzeit die ARD Mediathek und die ZDFmediathek.

So geht's: Raum erstellen, Code an Freunde schicken, fertig. Wer beitritt, landet automatisch bei derselben Sendung. Play, Pause und Sprünge gelten für alle.

• Jede Person schaut im offiziellen Player der Mediathek. Synchronisiert werden nur Play, Pause und Position – Videos werden weder kopiert noch weitergeleitet.
• Host-Funktionen: Steuerrecht festlegen, Teilnehmerlimit, Teilnehmer entfernen, Host-Rolle übergeben, alle auf die eigene Position holen.
• Automatisch folgen: Startet jemand eine andere Sendung, wechseln alle mit (abschaltbar).
• Ohne Konto nutzbar. Mit kostenlosem Synchrothek-Konto zusätzlich: Freunde direkt einladen, Weiterschauen, Marker mit Notizen, persönliche Statistik. Gespeichert wird nur nach ausdrücklicher Einwilligung – getrennt je Funktion, für gemeinsames und alleiniges Schauen, jederzeit widerrufbar.
• Kein Tracking, keine Werbung. Server in Deutschland. Open Source (AGPL-3.0). Eigener Sync-Server möglich.

Hinweis: Synchrothek ist ein unabhängiges, privates Projekt und steht in keiner Verbindung zu ARD, ZDF oder anderen Rundfunkanstalten. Die Namen der Mediatheken dienen nur der Beschreibung der unterstützten Seiten. Alle Teilnehmenden müssen den Inhalt selbst abrufen können (Verweildauer, Geoblocking).

Datenschutz: https://synchrothek.de/datenschutz · Kontakt: contact@synchrothek.de
```

### Grafiken

- Icon 128×128: `store/icon-128.png`
- Screenshots 1280×800 (1–5): Raum erstellen (Popup mit Code), Raum mit Teilnehmenden, Freunde einladen, Weiterschauen/Marker, Einstellungen/Einwilligungen. Ohne Senderlogos und ohne Bilder aus Sendungen.
- Chrome optional: kleine Promo-Kachel 440×280, Marquee 1400×560 (nur Synchrothek-Logo).

### Hinweise für Prüfer (Testkonto selbst eintragen, nicht ins Repo)

```
Synchrothek syncs playback between several people watching the same programme in the official player of the ARD Mediathek or ZDFmediathek.

Test without account: open a programme on www.ardmediathek.de or www.zdf.de in two browser profiles, click the extension icon → "Raum erstellen" in profile 1, enter the room code via "Beitreten" in profile 2. Play/pause/seek are synced.

Test with account (optional features: invitations, resume, bookmarks, statistics): sign in via "Anmelden" with the test account below. Data is only stored after explicit consent in the popup (separately per feature and for watching alone).

Test account: <Benutzername> / <Passwort>

The optional custom server setting (ws:// or wss://) is only set by the user; account tokens are never sent to custom servers.
Build (Firefox): Node 24 LTS, npm 11: npm ci && npm run build:firefox → .output/firefox-mv3/
```

## Chrome Web Store

- **Kategorie:** Lifestyle → Unterhaltung
- **Single Purpose:** Synchrothek synchronisiert die Wiedergabe in Mediatheken zwischen mehreren Personen (gemeinsam schauen). Die Funktionen mit optionalem Konto (Einladungen, Weiterschauen, Marker, Statistik) dienen ausschließlich diesem Schauen.
- **Remote Code:** No, I am not using remote code.
- **Begründungen der Berechtigungen:**
  - `storage`: Stores settings locally (display name, auto-follow, optional custom server) and a random installation ID; keeps the current room in session storage so the extension can rejoin after the service worker restarts.
  - `identity`: Sign-in with the optional Synchrothek account via OAuth 2.0 + PKCE (identity.launchWebAuthFlow, login page on app.synchrothek.de). No Google account is used; the extension never sees the password.
  - `alarms`: When signed in, checks about once per minute for room invitations from friends, even while the service worker is suspended.
  - `notifications`: Shows a system notification when a friend invites you to a watch room (join/decline).
  - Host permissions: `*.ardmediathek.de`, `*.zdf.de`: content script attaches to the official player's video element to sync play/pause/position; the room tab's URL is read so everyone opens the same programme. `app.synchrothek.de`: token/revocation/profile endpoints of the account sign-in and a version check on the help page. `api.synchrothek.de`: resume position, bookmarks, friends, invitations and statistics (only with consent).
- **Datenkategorien (Privacy practices):** Personally identifiable information (Anzeigename, Benutzername, Installations-ID), Authentication information (Anmelde-Token), Web history (Adresse der Sendung), User activity (Play/Pause/Position), Website content (Titel der Sendung). Nicht: Gesundheit, Finanzen, Standort, persönliche Kommunikation.
- **Zusicherungen:** alle drei anhaken (kein Verkauf, keine zweckfremde Nutzung, keine Kreditwürdigkeitsprüfung).
- **Händlerstatus (DSA):** Nicht-Händler (privates, nicht kommerzielles Projekt).
- **Nach dem ersten Upload:** Item-ID notieren, Public Key („Package → View public key“) in `wxt.config.ts` (`CHROME_KEY`) übernehmen; Item-ID in `OAUTH_CHROME_EXTENSION_IDS` (Plattform) und `chrome-extension://<ID>` in `EXTENSION_ORIGINS` (Vermittler) eintragen.

## addons.mozilla.org

- **Plattform:** nur Firefox (Desktop)
- **Zusammenfassung** (≤ 250 Zeichen): Schaut Sendungen aus der ARD Mediathek und der ZDFmediathek gemeinsam: Play, Pause und Position bleiben für alle im Raum synchron. Jede Person schaut im offiziellen Player, Videos werden nicht kopiert. Ohne Konto nutzbar, ohne Werbung und Tracking.
- **Kategorien:** Fotos, Musik & Videos; Soziale Netzwerke & Kommunikation
- **Lizenz:** GNU Affero General Public License v3.0
- **Quellcode:** Ja – `synchrothek-<version>-sources.zip` hochladen (Build-Anleitung in den Prüferhinweisen)
- **Datenübertragung** steht im Manifest (`data_collection_permissions`) und erscheint bei der Installation.
- **Add-on-ID:** `synchrothek@synchrothek.de` (fest, Redirect-URI `https://04dc844948c3ffb3c2adec34b663d47578d2ac33.extensions.allizom.org/`).
