# Store-Einträge (Chrome Web Store und addons.mozilla.org)

Texte und Angaben zum Kopieren, auf Deutsch (Standard) und Englisch (Abschnitt „English listing“). Pakete: `npm run zip` (Chrome) und `npm run zip:firefox` (Firefox-Paket und Quellen-ZIP) in `.output/`.

## Gemeinsam

- **Name:** Synchrothek
- **Kurzbeschreibung** (Chrome ≤ 132 Zeichen, = Manifest-`description`):
  Öffentlich-rechtliche Mediatheken gemeinsam schauen: Play, Pause und Position synchron – jede Person im offiziellen Player.
- **Website:** https://synchrothek.de
- **Support:** https://app.synchrothek.de/hilfe · contact@synchrothek.de
- **Datenschutzerklärung:** https://synchrothek.de/datenschutz
- **Quellcode:** https://github.com/Synchrothek/synchrothek (AGPL-3.0-only)
- **Sprachen:** Deutsch, Englisch (Oberfläche folgt dem Browser, im Popup umschaltbar; Manifest mit `_locales`, `default_locale` = `en`)

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

The interface follows the browser language (German if the preferred language starts with "de", otherwise English) and can be switched in the popup under Settings → Language.

Test without account: open a programme on www.ardmediathek.de or www.zdf.de in two browser profiles, click the extension icon → "Create room" ("Raum erstellen") in profile 1, enter the room code via "Join" ("Beitreten") in profile 2. Play/pause/seek are synced.

Test with account (optional features: invitations, resume, bookmarks, statistics): sign in via "Sign in" ("Anmelden") with the test account below. Data is only stored after explicit consent in the popup (separately per feature and for watching alone).

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

## English listing

Texte für die zweite Sprache in Chrome Web Store und AMO. Inhaltlich gleich wie die deutsche Fassung.

- **Name:** Synchrothek
- **Short description** (Chrome ≤ 132 characters, = English manifest `description` from `public/_locales/en/messages.json`):
  Watch Germany's public broadcasters' media libraries together: play, pause and position in sync – everyone in the official player.
- **Website:** https://synchrothek.de/en/
- **Support:** https://app.synchrothek.de/hilfe?lang=en · contact@synchrothek.de
- **Privacy policy:** https://synchrothek.de/en/privacy
- **Source code:** https://github.com/Synchrothek/synchrothek (AGPL-3.0-only)

### Detailed description

```
With Synchrothek you watch programmes from the German public broadcasters' media libraries together – even when you're in different places. Currently supported: ARD Mediathek and ZDFmediathek.

How it works: create a room, send the code to your friends, done. Everyone who joins lands on the same programme automatically. Play, pause and seeking apply to everyone.

• Everyone watches in the media library's official player. Only play, pause and position are synced – videos are never copied or passed on.
• Host features: decide who can control playback, set a participant limit, remove participants, hand over the host role, bring everyone to your position.
• Follow automatically: if someone starts a different programme, everyone switches along (can be turned off).
• Works without an account. With a free Synchrothek account you also get: invite friends directly, continue watching, markers with notes, personal statistics. Data is only stored after your explicit consent – separately for each feature, for watching together and alone, and you can withdraw it at any time.
• No tracking, no ads. Servers in Germany. Open source (AGPL-3.0). You can run your own sync server.
• Interface in English and German.

Note: Synchrothek is an independent, private project and is not affiliated with ARD, ZDF or any other broadcaster. The names of the media libraries are only used to describe the supported sites. Everyone needs to be able to access the content themselves (availability periods, geo-blocking).

Privacy: https://synchrothek.de/en/privacy · Contact: contact@synchrothek.de
```

### Screenshots

- Same motifs as the German set (1280×800), taken with the interface set to English (Settings → Language → English). Tobias takes them himself; no broadcaster logos and no images from programmes.

### Permission justifications (Chrome, English – same as above)

- `storage`: Stores settings locally (display name, language, auto-follow, optional custom server) and a random installation ID; keeps the current room in session storage so the extension can rejoin after the service worker restarts.
- `identity`: Sign-in with the optional Synchrothek account via OAuth 2.0 + PKCE (identity.launchWebAuthFlow, login page on app.synchrothek.de). No Google account is used; the extension never sees the password.
- `alarms`: When signed in, checks about once per minute for room invitations from friends, even while the service worker is suspended.
- `notifications`: Shows a system notification when a friend invites you to a watch room (join/decline).
- Host permissions: `*.ardmediathek.de`, `*.zdf.de`: the content script attaches to the official player's video element to sync play/pause/position; the room tab's URL is read so everyone opens the same programme. `app.synchrothek.de`: token/revocation/profile endpoints of the account sign-in and a version check on the help page. `api.synchrothek.de`: resume position, bookmarks, friends, invitations and statistics (only with consent).
- **Single purpose:** Synchrothek syncs playback in media libraries between several people (watching together). The optional account features (invitations, continue watching, markers, statistics) exclusively serve this watching.

### Data categories (Privacy practices, English)

- Personally identifiable information: display name in the room, account username, random installation ID.
- Authentication information: sign-in tokens (only to the official platform and the official sync service).
- Web history: address of the programme being watched (room; with consent: continue watching, markers, statistics).
- User activity: play, pause and position in the player.
- Website content: title and series name of the programme, marker notes.
- Not collected: health, financial, location, personal communications.

### AMO summary (≤ 250 characters)

Watch programmes from ARD Mediathek and ZDFmediathek together: play, pause and position stay in sync for everyone in the room. Everyone watches in the official player; videos are not copied. Works without an account, no ads or tracking.

### Notes for reviewers

Die Prüferhinweise oben sind schon englisch und gelten für beide Sprachen (Testkonto weiterhin selbst eintragen).

## Zweite Sprache eintragen (für Tobias)

**Chrome Developer Dashboard** (Eintrag `ogecioeoilcegakfimcfnlojjnnponmn`):

1. Version 0.6.0 hochladen (`.output/synchrothek-0.6.0-chrome.zip`). Weil das Paket jetzt `_locales` mit `default_locale: en` enthält, zeigt das Dashboard unter *Store-Eintrag* eine Sprachauswahl (Deutsch, Englisch). Name und Kurzbeschreibung kommen je Sprache aus dem Paket und sind dort nicht editierbar.
2. Sprache **Deutsch**: bisherige Texte prüfen (ausführliche Beschreibung, Screenshots, Promo-Kachel, Marquee). Sprache **Englisch**: „Detailed description“ von oben einfügen, englische Screenshots hochladen (Promo-Kachel und Marquee ohne Text können gleich bleiben).
3. *Datenschutz*: Begründungen und Datenkategorien gelten für alle Sprachen (Dashboard ist einsprachig); bei Bedarf die englischen Begründungen oben verwenden. Die Datenschutz-URL ist ein Feld für alle Sprachen – `https://synchrothek.de/datenschutz` stehen lassen (die Seite verlinkt die englische Fassung) oder auf `https://synchrothek.de/en/privacy` umstellen, wenn die englische Seite live ist.
4. Zur Prüfung einreichen.

**addons.mozilla.org** (`synchrothek@synchrothek.de`):

1. Version 0.6.0 hochladen (`synchrothek-0.6.0-firefox.zip`) plus Quellen-ZIP (`synchrothek-0.6.0-sources.zip`); Prüferhinweise wie oben.
2. *Edit Product Page*: Die Standardsprache des Eintrags ist die bisherige (Deutsch). Oben rechts über die Sprachauswahl („Locale“) **English (US)** bzw. **English (British)** wählen bzw. hinzufügen und dort Name (Synchrothek), Summary (AMO summary oben), Description (Detailed description oben), Homepage (`https://synchrothek.de/en/`), Support-URL (`https://app.synchrothek.de/hilfe?lang=en`) eintragen. AMO zeigt ohne passende Übersetzung die Standardsprache.
3. Unter *Privacy Policy* kann pro Sprache ein Text hinterlegt werden; falls genutzt, für Englisch auf `https://synchrothek.de/en/privacy` verweisen.
4. Englische Screenshots unter *Images* ergänzen (AMO-Screenshots gelten für alle Sprachen; Bildunterschriften lassen sich je Sprache übersetzen).
