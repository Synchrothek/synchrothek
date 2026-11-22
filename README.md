# Synchrothek

> **English summary:** Synchrothek is a browser extension (Manifest V3, Chrome and Firefox) for watching content from the German public broadcasters' media libraries together. Everyone watches in the official player; only play, pause and position are synchronised via a small WebSocket server (self-hostable). An optional Synchrothek account adds resume, markers, statistics and friends – watch history is only stored with explicit consent. Licensed under AGPL-3.0-only. Independent project, not affiliated with ARD or ZDF. Security reports: see [SECURITY.md](SECURITY.md).

Browser-Extension (Manifest V3, Chrome & Firefox), mit der mehrere Personen Inhalte aus öffentlich-rechtlichen Mediatheken synchron gemeinsam schauen, ähnlich wie Watch2Gether oder Teleparty.

Jede Person schaut über den offiziellen Player der Mediathek. Synchronisiert werden nur Play, Pause und Position über einen kleinen WebSocket-Server. Inhalte werden weder kopiert noch weiterverbreitet.

Unterstützt: ARD Mediathek, ZDF Mediathek.

Synchrothek ist ein **unabhängiges Projekt und steht in keiner Verbindung zu ARD oder ZDF**.

## Server

Die Extension verbindet sich standardmäßig mit dem öffentlichen Server des Projekts. Wer lieber einen eigenen betreibt, findet ihn samt Docker-Compose-Setup im Repository **[synchrothek-server](https://github.com/synchrothek/synchrothek-server)** und trägt ihn im Popup unter *Einstellungen → Server* ein (`wss://…` oder im Heimnetz `ws://IP:8080`).

Die Standardadresse steht in [`src/lib/config.ts`](src/lib/config.ts). Der Server muss zur Extension passen (Protokollversion 2, Server ab 0.2.0; Tickets für den Knoten-Pool ab 0.6.0).

### Offizieller Sync-Dienst (Knoten-Pool)

Der offizielle Dienst besteht aus einem Vermittler (`https://sync.synchrothek.de/v1`) und mehreren Knoten (`wss://<kürzel>.sync.synchrothek.de`), Überblick: [`docs/offizielle-dienste.md`](docs/offizielle-dienste.md). Für selbst gehostete Server ändert sich nichts: direkt verbinden, nie Tokens senden.

- **Erstellen:** `POST /v1/rooms` (Body `{}`, angemeldet mit Token) liefert Raumcode, Knoten und ein Ticket (einmal gültig, 60 s). Die Extension verbindet sich mit dem Knoten, sendet angemeldet zuerst `auth` und wartet auf die Antwort, dann `create` mit Ticket. Lehnt der Vermittler ab (`server_full`, `maintenance`, `rate_limited` …), bleibt ein bestehender Raum erhalten. Liegt der neue Raum auf demselben Knoten, nutzt die Extension die bestehende Verbindung; sonst verlässt sie den alten Raum erst, wenn der Vermittler zugesagt hat.
- **Beitreten:** `GET /v1/rooms/<CODE>` nennt den Knoten, danach `join` wie bisher. 404 → „Raum … nicht gefunden.“
- **Wiederverbinden:** zuerst direkt zum zuletzt benutzten Knoten (in `storage.session`). Nach 3 Fehlversuchen fragt die Extension den Vermittler (`GET /v1/rooms/<CODE>`): Nennt er einen anderen Knoten, verbindet sie sich dorthin; antwortet er mit 404, wird der Raum mit dem Hinweis „Der Raum … besteht nicht mehr.“ beendet; ist er nicht erreichbar, geht es mit dem bekannten Knoten weiter.
- **Beitreten bei gestörtem Vermittler:** Hinweis mit Knopf „Erneut versuchen“.
- **Fehler:** Meldung des Vermittlers anzeigen; `ticket_invalid`, `auth_unavailable` und „Der Sync-Dienst ist gerade nicht erreichbar.“ mit Knopf „Erneut versuchen“ (holt ein neues Ticket). `401 auth_failed`: einmal mit erneuertem Token, sonst Hinweis zum neuen Anmelden. Nach `429` wartet die Extension `Retry-After` ab, bevor sie den Vermittler wieder fragt.
- **Sicherheit:** Tokens gehen nur an `https://sync.synchrothek.de` und an Knoten, deren Adresse genau `wss://<name>.sync.synchrothek.de` ist (ohne Port, Pfad, Zugangsdaten); jede andere Knoten-Adresse vom Vermittler wird abgelehnt, ohne zu verbinden. Der Vermittler wird ohne Host-Berechtigung per CORS angesprochen (Extension-Origins sind dort freigegeben).

## Entwicklung

Benötigt Node.js ≥ 24 (empfohlen: aktuelle LTS-Version). Die Extension ist in TypeScript geschrieben und wird mit [WXT](https://wxt.dev) gebaut.

```sh
npm install
npm run dev            # Chrome mit automatisch neu geladener Extension
npm run dev:firefox    # dasselbe für Firefox
npm run build          # → .output/chrome-mv3/
npm run build:firefox  # → .output/firefox-mv3/
npm run zip            # Pakete für die Stores
npm run typecheck
```

Gebaute Extension von Hand laden:

- **Chrome (≥ 127):** `chrome://extensions` → Entwicklermodus → *Entpackte Erweiterung laden* → `.output/chrome-mv3/`
- **Firefox (≥ 140):** `about:debugging#/runtime/this-firefox` → *Temporäres Add-on laden* → `.output/firefox-mv3/manifest.json`. Falls nötig in `about:addons` unter *Berechtigungen* den Zugriff auf die Mediathek-Seiten erlauben.

Für lokale Tests den Server starten (`npm start` im Server-Repo) und im Popup unter *Einstellungen* `ws://localhost:8080` eintragen. Zum Ausprobieren allein reichen zwei Browserprofile.

### Build für die Prüfung auf addons.mozilla.org

Für AMO-Prüfer: Das hochgeladene Paket lässt sich aus dem Quellen-ZIP reproduzierbar bauen.

- Voraussetzungen: **Node.js 24 LTS** (oder neuer) und **npm 11**, Linux, macOS oder Windows.
- Bauen: `npm ci && npm run build:firefox` → Ergebnis in `.output/firefox-mv3/` (entspricht dem Inhalt des eingereichten Pakets).
- `npm run zip:firefox` erzeugt in `.output/` das Paket (`synchrothek-<version>-firefox.zip`) und das Quellen-ZIP (`synchrothek-<version>-sources.zip`).
- Keine minifizierten Fremdquellen; alle Abhängigkeiten kommen aus `package-lock.json` (npm-Registry). Die Schrift IBM Plex wird aus `@fontsource` mitgeliefert.

### Chrome-Extension-ID

Für den Login braucht Chrome eine feste Extension-ID (Redirect-URI `https://<id>.chromiumapp.org/`). Beim Entwickeln sorgt dafür der Schlüssel `key` in `wxt.config.ts`: der öffentliche Schlüssel der Chrome-Web-Store-Version (ID `ogecioeoilcegakfimcfnlojjnnponmn`), Entwicklungs-Builds haben also dieselbe ID wie die Store-Version.

- `key` steht nur in Entwicklungs- und Testbuilds im Manifest (`npm run dev`, `--mode e2e`) oder wenn `CHROME_KEY_IN_MANIFEST=1` gesetzt ist. Das ZIP für den Chrome Web Store (`npm run zip`) enthält ihn nicht; dort ist die ID ohnehin festgelegt.
- Der öffentliche Schlüssel stammt aus dem Developer Dashboard (*Paket* → „Öffentlichen Schlüssel ansehen“) und ist als `CHROME_KEY` in `wxt.config.ts` eingetragen.
- **Neue Extension-ID eintragen:** in der Plattform (`OAUTH_CHROME_EXTENSION_IDS`, für die Redirect-URI des Clients `synchrothek-chrome`) und beim Vermittler (`EXTENSION_ORIGINS`, CORS für `chrome-extension://<id>`). Ohne diese Einträge schlagen Login und Raum erstellen in der Store-Version fehl.
- Firefox: Die Redirect-URI hängt von der Add-on-ID `synchrothek@synchrothek.de` ab (`https://04dc844948c3ffb3c2adec34b663d47578d2ac33.extensions.allizom.org/`) und bleibt gleich.

**Protokoll:** Die Nachrichtentypen stammen aus dem Server-Repo (`src/protocol.ts`, dort die Referenz). Nach Änderungen dort `npm run sync-protocol` ausführen. Die CI prüft, dass beide übereinstimmen.

## Benutzung

1. Popup öffnen und *Raum erstellen*, am besten direkt auf der Seite einer Sendung.
2. Den Code (Klick kopiert ihn) an die anderen schicken.
3. Die anderen geben den Code ein und klicken auf *Beitreten*. Das geht aus jedem Tab, auch aus einem leeren. Die Sendung des Raums öffnet sich automatisch.

**Sendung wechseln:** Startet jemand im Raum-Tab eine andere Sendung, wechseln alle mit. Das zählt bei Wiedergabe mit Ton oder nach einem Klick. Stumm automatisch startende Vorschauvideos auf Übersichtsseiten lösen keinen Wechsel aus. Notfalls hilft der Button *Diese Sendung für alle starten* im Popup.

**Automatisch folgen** lässt sich in den Einstellungen abschalten. Dann bleibt man auf der eigenen Seite und wechselt bei Bedarf über *Zur Sendung des Raums wechseln*. Auch mit eingeschaltetem Folgen wird man je Sendung nur einmal hingeführt. Wer danach wegnavigiert, wird nicht zurückgeholt.

Erlaubt der Browser nach einem automatischen Wechsel keine Wiedergabe mit Ton, startet das Video stumm und ein Button bietet an, den Ton einzuschalten.

**Im Popup:**

- **Steuerung:** Abspielen/Pausieren und 10 Sekunden vor oder zurück, für alle im Raum
- **Alle auf meine Position synchronisieren** (Host): Alle springen zur tatsächlichen Position des Hosts.
- **Teilnehmerliste** mit Namen. Den eigenen Namen legst du unter *Einstellungen* fest. Angemeldet ist der Benutzername des Kontos nur ein Vorschlag; ein selbst gewählter Name gilt auch mit Konto (*Konto-Namen verwenden* stellt den Vorschlag wieder her).
- **Für den Host:**
  - Teilnehmer entfernen oder bannen
  - Host-Rolle übergeben
  - Teilnehmerlimit setzen
  - festlegen, ob alle oder nur der Host steuern dürfen
- **Host-Wechsel:** Verlässt der Host den Raum, übernimmt automatisch die Person, die am längsten dabei ist. Bei einem kurzen Verbindungsabbruch bleiben Platz und Host-Rolle 30 Sekunden lang erhalten.
- **Raumdauer:** Hat der Server eine maximale Raumdauer, zeigt das Popup das Ende an. 10 Minuten vorher werden alle gewarnt.

## Weiterschauen und Marker (mit Synchrothek-Konto)

Wer mit einem Synchrothek-Konto angemeldet ist, findet im Popup unter dem Konto zwei Funktionen. Beide speichern auf der Plattform (`https://api.synchrothek.de/v1`, API der offiziellen Plattform, siehe [`docs/offizielle-dienste.md`](docs/offizielle-dienste.md)) und **nur nach ausdrücklicher Einwilligung**, getrennt je Funktion:

- **Weiterschauen:** Während der Wiedergabe wird die Position etwa alle 20 Sekunden gespeichert, außerdem bei Pause, am Ende und beim Verlassen der Seite. Öffnet man die Sendung wieder, bietet ein Hinweis im Player „Weiterschauen ab 37:12?“ an (nicht im Raum-Tab, dort gibt der Raum die Position vor). Im Popup steht unter *Zuletzt geschaut* die Liste.
- **Marker:** Stelle in der laufenden Sendung merken, optional mit kurzer Notiz (bis 200 Zeichen). Ein Klick auf die Zeit springt dorthin. Im Raum-Tab gilt der Sprung für alle und braucht deshalb das Steuerrecht.

Einwilligung: Beim ersten Benutzen zeigt das Popup Titel und Text, die die Plattform liefert (`GET /v1/consent`), mit Link „Mehr in der Datenschutzerklärung“ und den gleichwertigen Knöpfen *Einwilligen* und *Nicht jetzt*. Die Texte sind bewusst nicht in der Extension eingebaut. Erst *Einwilligen* sendet `PUT /v1/consent` mit genau dieser Fassung. Ist eine Einwilligung in einer älteren Fassung erteilt (`version` ≠ `currentVersion`), bietet das Popup die neue Fassung an; die alte gilt bis dahin weiter. Widerrufen geht unter *Einstellungen → Einwilligungen* oder auf `app.synchrothek.de/einwilligungen`. Dabei löscht die Plattform sofort alle Daten der Funktion. Den Einwilligungsstand hält die Extension nur kurz im Speicher, nie dauerhaft. Antwortet die API mit `403 consent_required` (z. B. nach Widerruf auf der Webseite), ist die Funktion sofort aus und wird im Popup wieder angeboten, ohne Hinweis im Player.

Ohne Konto oder ohne Einwilligung funktioniert alles wie bisher, es wird nichts gesendet. Schauverlauf und Marker speichert die Extension nicht lokal.

Technisch: Nur der Background ruft die API auf (die API sendet keine CORS-Header), mit `Authorization: Bearer <access_token>`. Das Token geht ausschließlich an die fest eingebaute Adresse. Bei `401 token_expired`/`invalid_token` wird das Token erneuert und die Anfrage einmal wiederholt, scheitert sie erneut, bietet das Popup *Erneut anmelden* an. Nach `429` pausiert die Extension bis `Retry-After`. In Firefox lässt sich der Zugriff auf `api.synchrothek.de` entziehen. Dann bietet das Popup *Zugriff erlauben* an.

### Gemeinsam und allein

Weiterschauen, Marker und Statistik gibt es in zwei getrennten Sammlungen:

- **Gemeinsam** (`context: room`): Der Tab ist der Raum-Tab eines Raums auf dem offiziellen Sync-Server. Dafür reicht die Haupteinwilligung (`watch_progress`, `markers`, `statistics`).
- **Allein** (`context: solo`): alles andere – kein Raum, ein anderer Tab oder ein selbst gehosteter Server. Gesendet wird nur, wenn zusätzlich die Zusatz-Einwilligung erteilt ist (`watch_progress_solo`, `markers_solo`, `statistics_solo`); sonst nichts.

Im Popup hat jede Funktion unter *Meine Mediathek* den Schalter **„Auch beim alleine Schauen“** (Standard aus, nur bei erteilter Haupteinwilligung). Einschalten zeigt den eigenen Einwilligungstext der Plattform, Ausschalten widerruft und löscht sofort die Allein-Daten der Funktion; *Allein-Daten löschen* löscht sie ohne Widerruf (`DELETE /v1/solo-data`). Gelesen wird mit passendem `context`: „Weiterschauen ab …?“ und Marker aus der Sammlung des Tabs, die Liste *Zuletzt geschaut* zeigt beide (Einträge „allein“ markiert), der Statistik-Überblick ebenfalls.

**Statistik allein** misst die Extension selbst: Sie zählt nur laufende Wiedergabe im Speicher und meldet gesammelt per `POST /v1/stats/solo` – beim Ende, beim Verlassen der Seite, beim Wechsel der Sendung oder in einen Raum, nach 3 Minuten Pause und spätestens alle 10 Minuten. Abschnitte unter 30 Sekunden werden verworfen, höchstens 50 Meldungen pro Stunde. Betritt man einen Raum, wird der laufende Abschnitt abgeschlossen; danach zählt der Sync-Server. Die Entscheidungslogik steht in `src/lib/watch-context.ts`, die Zählung in `src/lib/solo-stats.ts` (beide mit Unit-Tests).

Ist auf der Seite ein Formatname angegeben (JSON-LD `partOfSeries.name`), geht er als `series` mit Weiterschauen und Markern an die Plattform.

## Freunde, Raum-Einladungen und Statistik (mit Synchrothek-Konto)

API der offiziellen Plattform, siehe [`docs/offizielle-dienste.md`](docs/offizielle-dienste.md).

- **Freunde einladen:** Wer Host eines Raums auf dem Standardserver ist, findet im Raum *Freunde einladen* mit der Freundesliste (nur Benutzernamen). Ein Klick schickt eine Einladung mit Raumcode und Titel der Sendung, sie gilt 15 Minuten. Freunde hinzufügen, entfernen und blockieren geht auf `app.synchrothek.de/freunde`.
- **Einladungen bekommen:** Angemeldet fragt die Extension etwa jede Minute (`alarms`) und beim Öffnen des Popups nach Einladungen, nie öfter als alle 30 Sekunden. Eine neue Einladung erscheint einmal als Systembenachrichtigung (in Chrome mit *Beitreten*/*Ablehnen*), als Zahl am Symbol und oben im Popup. *Beitreten* tritt dem Raum auf dem Standardserver bei (ein eigener Server in den Einstellungen wird dafür zurückgesetzt) und löscht danach die Einladung, *Ablehnen* löscht sie nur.
- **Statistik:** Die Zuschauzeit in gemeinsamen Räumen misst der Sync-Server, die Extension sendet dafür nichts. Sie holt nur die Einwilligung `statistics` ein (gleicher Dialog, Text von der Plattform). Weil die Einwilligung im Token für den Sync-Server steckt, erneuert die Extension nach Erteilen oder Widerruf sofort das Token und meldet es dem Sync-Server. Mit Einwilligung zeigt das Popup einen Überblick über 30 Tage, das Dashboard liegt auf `app.synchrothek.de/statistik`.
- **Profilbilder:** Das Popup zeigt bei „Angemeldet als …“ und in der Freundesliste die Profilbilder (`GET /v1/me`, `GET /v1/friends`, Bild über `GET /v1/avatars/…`). Die Bilder gibt es nur mit Token, deshalb lädt sie der Hintergrund per `fetch` (nur von `https://api.synchrothek.de/v1/avatars/`) und gibt sie dem Popup, das sie als Blob-URL anzeigt. Weil eine `avatarUrl` mit `?v=…` unveränderlich ist, liegen die Bilder dauerhaft im Cache der Extension (Cache API) unter dieser URL; neue URL = neues Bild, alte und nicht mehr gebrauchte fliegen raus, beim Abmelden wird der Cache geleert. In der Freundesliste werden Bilder erst geladen, wenn sie sichtbar werden (Rate-Limit). Ohne Bild oder bei `404` erscheint die Initiale.
- **Im Konto abgemeldet** (`app.synchrothek.de/einstellungen#konto-geraete`), abgelaufen oder widerrufen: Der nächste Token-Refresh scheitert mit `invalid_grant`. Die Extension zeigt dann genau einen Hinweis, vergisst die Anmeldung und läuft ohne Konto weiter. Alle späteren Aufrufe unterbleiben, weil es kein Token mehr gibt.

## Hinweise der Plattform und Kontosperre

- **Client-Konfiguration:** Beim Start und beim Öffnen des Popups (höchstens alle 5 Minuten) fragt die Extension ohne Token `GET /v1/client-config` ab (`docs/api.md` 2a). Ist die eigene Version älter als `minExtensionVersion` (numerisch je Stelle verglichen), zeigt das Popup „Bitte aktualisiere Synchrothek“; ein `notice` erscheint als Hinweisbanner (nur Text). Fehler beim Abruf werden ignoriert.
- **Raum erstellen abgelehnt:** Meldet der Sync-Server `server_full` oder `maintenance`, zeigt das Popup die Meldung des Servers. Es entsteht kein Raum, und wer schon in einem Raum ist, bleibt darin (die Extension erstellt aus einem Raum heraus über die bestehende Verbindung und verlässt den alten Raum erst, wenn der neue steht). Unbekannte Fehlercodes zeigen ebenfalls die Meldung des Servers.
- **Raum schließt / beendet:** Ankündigung und Meldung je Grund (`duration`, `idle`, `shutdown`, `admin`), unbekannte Gründe eine allgemeine Meldung.
- **Update-Hinweis:** Store-Installationen aktualisieren sich automatisch; das Popup nennt den Weg zum sofortigen Aktualisieren (Chrome: `chrome://extensions` → *Aktualisieren*, Firefox: `about:addons` → *Nach Updates suchen*), selbst geladene Versionen müssen neu geladen werden.
- **Kontosperre:** `403 account_banned` von der API oder `invalid_grant` mit „Dieses Konto ist gesperrt.“ beim Token-Refresh: Die Extension meldet sich ab und zeigt „Dieses Konto ist gesperrt.“ – einmal, ohne weitere Versuche.

## Versionsabfrage auf app.synchrothek.de

Auf „Hilfe & Kontakt“ fragt die Plattform per `window.postMessage` nach der installierten Version (Handshake wie von der offiziellen Plattform vorgegeben). Ein eigenes Content-Script nur für `https://app.synchrothek.de/*` (nur oberster Frame) antwortet ausschließlich auf diese eine Anfrage aus demselben Fenster und derselben Origin, mit Version und Browser (`chrome`/`firefox`), an `location.origin`. Es sendet nichts ungefragt und gibt keine Tokens oder sonstigen Daten heraus.

## Aufbau

```
src/
  entrypoints/
    background.ts   WebSocket-Verbindung, Raumzustand, Vermittlung (überlebt Seitenwechsel)
    content.ts      findet das <video> des Players, meldet und übernimmt Play/Pause/Seek
    app-bridge.content.ts  beantwortet auf app.synchrothek.de die Versionsabfrage von „Hilfe & Kontakt“
    popup/          Raum erstellen/beitreten, Steuerung, Teilnehmer, Einstellungen
  lib/
    config.ts       Standard-Server und unterstützte Seiten
    protocol.ts     Protokolltypen (aus dem Server-Repo übernommen)
    messages.ts     interne Nachrichten zwischen Background, Content-Script und Popup
    content-url.ts  „Gleiche Sendung?“ (URL-Vergleich)
    auth.ts         Login mit Synchrothek-Konto (OAuth, Tokens nur im Background)
    api.ts          Client für die Plattform-API (Weiterschauen, Marker, Einwilligungen)
    watch-features.ts  Einwilligungen, gedrosseltes Speichern, Marker, Statistik-Überblick (Background)
    social.ts       Freundesliste und Einladungen in Räume (Background)
    avatars.ts      eigenes Konto (/v1/me) und Profilbilder mit Cache (Background)
    client-config.ts  Mindestversion und Wartungshinweis der Plattform (ohne Token)
    broker.ts       Vermittler des offiziellen Sync-Dienstes (Raum erstellen/finden, Knoten-Adressen prüfen)
    watch-context.ts  gemeinsam/allein und welche Einwilligung zum Senden nötig ist
    solo-stats.ts   Zuschauzeit beim alleine Schauen sammeln und gesammelt melden
    url-match.ts    Host-Prüfung gegen die Match-Patterns (Mediatheken, Plattform)
    series.ts       Formatname aus JSON-LD der Seite
docs/               Überblick über die offiziellen Dienste
store/              Store-Icon (128 × 128 mit 16 px Rand)
e2e/                End-to-End-Test mit mehreren Chromium-Profilen
test/               Unit-Tests (`npm test`, ohne Browser)
public/             Icons und Symbol für Benachrichtigungen
scripts/            Hilfsskripte (Protokoll übernehmen, Icons erzeugen)
wxt.config.ts       Build- und Manifest-Konfiguration
```

- Der Raum ist an einen Tab gebunden. Code, Tab, Knoten und ein geheimer Wiederverbindungs-Token liegen in `storage.session`, damit nach einem Neustart des Service Workers automatisch wieder beigetreten wird, mit derselben Rolle.
- Das Content-Script filtert Echos eigener Änderungen heraus. Autoplay oder automatisches Fortsetzen durch den Player kurz nach dem Laden überschreibt den Raum nicht.
- Weicht ein Player um mehr als 2 s ab, springt er an die richtige Stelle.
- Namen anderer Teilnehmer werden nur als Text dargestellt, nie als HTML.
- Der Raum-Tab wird nur zu `https`-Seiten der unterstützten Mediatheken geführt (echte Host-Prüfung); andere Adressen vom Server werden ignoriert, mit Hinweis. Ebenso teilt der Raum-Tab nur Mediathek-Seiten.
- Der Hintergrund nimmt nur Ports an: vom eigenen Popup (`popup.html`, nicht aus einem Tab) und von eigenen Content-Scripts auf Mediathek- bzw. Plattform-Seiten. Einzelnachrichten und Nachrichten von außen werden nicht angenommen.

## Tests

```sh
npm test            # Unit-Tests: API-Client, gemeinsam/allein, Zählung allein, Host-Prüfung, Einladungen (Node, ohne Browser)
npm run e2e:setup   # einmalig: Chromium für Playwright + Testvideo (braucht ffmpeg)
npm run test:e2e    # baut die Extension im Testmodus und startet den Test
```

Der E2E-Test braucht das Server-Repo als Nachbarordner (`../synchrothek-server`, mit `npm install`) oder unter `SYNCHROTHEK_SERVER_DIR`. Er leitet `https://www.zdf.de/*` auf eine lokale Testseite um. Geprüft wird die Sync-Logik, nicht die echten Player der Sender.

Nur der Testbuild (`--mode e2e`) enthält einen Zugang für die Teststeuerung. Release-Builds enthalten ihn nicht.

## Fahrplan

1. ✅ Räume, Sync von Play/Pause/Seek, automatisches Folgen
2. ✅ Host-Rolle, Kicken/Bannen, Teilnehmerlimit, Steuerung im Popup, Sync zum Host, Schließen inaktiver Räume
3. Drift-Korrektur über `playbackRate`, Uhrabgleich per Ping/Pong, Buffering (puffert jemand, pausieren alle)
4. Weitere Mediatheken (arte, 3sat)
5. Accounts (offizielle Instanz): ✅ Login, ✅ Weiterschauen, ✅ Marker, ✅ Freunde und Raum-Einladungen, ✅ Statistik
6. Optional: eigener Web-Player auf Basis der MediathekView-Daten

## Hinweise

- Inhalte werden nach Ablauf ihrer Verweildauer depubliziert, manche sind geogeblockt. Alle Teilnehmenden müssen den Inhalt selbst abrufen können.
- Sendernamen sind Marken. Sie stehen nur zur Beschreibung der unterstützten Seiten hier, nicht im Namen oder Icon der Extension. Das Projekt steht in keiner Verbindung zu den Sendern.

### Datenübertragung (Firefox)

Das Firefox-Manifest erklärt unter `data_collection_permissions.required`, was die Extension überträgt:

| Kategorie | Warum |
|---|---|
| `personallyIdentifyingInfo` | Anzeigename im Raum (an den Sync-Server), angemeldet der Benutzername des Kontos |
| `browsingActivity` | Adressen der geschauten Sendungen: an den Sync-Server im Raum, mit Einwilligung an die Plattform (Weiterschauen, Marker, Statistik) |
| `websiteActivity` | Play, Pause und Position im Player (Kern der Synchronisation) |
| `websiteContent` | Titel und Formatname der Sendung, Notizen zu Markern |
| `authenticationInfo` | Anmelde-Token an die offizielle Plattform und den offiziellen Sync-Dienst |

Alles als „erforderlich“, weil schon das gemeinsame Schauen ohne Konto Name, Adresse und Wiedergabezustand an den Server sendet; Schauverlauf an die Plattform geht zusätzlich nur mit Einwilligung. Details: [`docs/offizielle-dienste.md`](docs/offizielle-dienste.md) und die [Datenschutzerklärung](https://synchrothek.de/datenschutz).

Das Popup nutzt die Schrift IBM Plex (SIL Open Font License 1.1, über `@fontsource`). Sie wird lokal mitgeliefert, nicht von Google Fonts geladen; die Lizenztexte liegen im Build unter `fonts/`.

## Mitmachen und Sicherheit

Beiträge: [CONTRIBUTING.md](CONTRIBUTING.md) (mit DCO-Sign-off und Contributor-Vereinbarung). Sicherheitslücken bitte nicht öffentlich melden, sondern wie in [SECURITY.md](SECURITY.md) beschrieben. Änderungen: [CHANGELOG.md](CHANGELOG.md).

## Lizenz

Copyright (C) 2026 Tobias-Pascal Mildenberger. Dieses Programm ist freie Software unter der GNU Affero General Public License Version 3 (nur diese Version), siehe [LICENSE](LICENSE). Der Name „Synchrothek“ ist von der Lizenz nicht umfasst.
