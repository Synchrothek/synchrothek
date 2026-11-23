# Offizielle Dienste, die die Extension nutzt

Die Extension funktioniert ohne Konto und auch mit einem selbst gehosteten Sync-Server. Standardmäßig – und für alle Kontofunktionen – spricht sie mit den offiziellen Diensten des Projekts. Alle Adressen sind fest eingebaut (`src/lib/config.ts`, `src/lib/broker.ts`).

## Endpunkte

| Dienst | Adresse | Wofür |
|---|---|---|
| Anmeldung (OAuth 2.0, PKCE) | `https://app.synchrothek.de/api/auth/oauth2/authorize`, `…/token`, `…/revoke`, `…/userinfo`, Metadaten `https://app.synchrothek.de/.well-known/oauth-authorization-server/api/auth` | Login mit Synchrothek-Konto, Erneuern und Widerrufen der Tokens, Benutzername |
| Plattform-API | `https://api.synchrothek.de/v1/...` | Einwilligungen, Weiterschauen, Marker, Statistik, Freunde, Raum-Einladungen, Profilbilder, Client-Konfiguration (`/v1/client-config`, ohne Anmeldung) |
| Vermittler | `https://sync.synchrothek.de/v1/rooms` | Raum erstellen (Raumcode, Knoten, Ticket) und Knoten eines Raums finden |
| Sync-Knoten | `wss://<name>.sync.synchrothek.de` | Gemeinsam schauen: Play, Pause, Position in Echtzeit |
| Versionsabfrage | Content-Script auf `https://app.synchrothek.de/*` | Beantwortet nur die Frage der Seite nach Version und Browser |

## Was gesendet wird

- **Sync-Knoten (im Raum):** Anzeigename, zufällige Installations-ID, Adresse der Sendung, Play/Pause/Position, Raumeinstellungen. Angemeldet zusätzlich das Access-Token (als Nachricht, nie in der URL).
- **Vermittler:** beim Erstellen ggf. das Access-Token (für die Grenzen des Kontos), beim Beitreten nur den Raumcode.
- **Plattform-API (nur angemeldet):**
  - Einwilligungen erteilen/widerrufen (mit der angezeigten Fassung).
  - Weiterschauen: Adresse, Titel, Formatname (falls auf der Seite angegeben), Position, Dauer – nur mit Einwilligung `watch_progress`; beim alleine Schauen nur zusätzlich mit `watch_progress_solo`.
  - Marker: Adresse, Titel, Formatname, Position, optionale Notiz – nur mit `markers` (allein zusätzlich `markers_solo`).
  - Statistik: gemeinsam misst der Sync-Server (Einwilligung `statistics` steckt im Token); allein meldet die Extension gesammelt Adresse, Sekunden und Startzeitpunkt (`POST /v1/stats/solo`), nur mit `statistics` und `statistics_solo`.
  - Freunde, Raum-Einladungen, eigenes Profil und Profilbilder.
- **Ohne Einwilligung wird kein Schauverlauf gesendet.** Den Einwilligungsstand prüft zusätzlich die Plattform selbst.
- Schauverlauf wird nicht dauerhaft lokal gespeichert, nur kurz im Speicher bis zum nächsten Senden.

## Sprache

- An die Plattform-API geht bei jeder Anfrage `Accept-Language: de` oder `en` (Sprache der Oberfläche der Extension). Die Plattform liefert `message` und Einwilligungstexte in dieser Sprache; die Fehlercodes sind in beiden Sprachen gleich.
- Vermittler und Sync-Knoten bekommen keine Sprachangabe. Die Extension übersetzt deren Fehler anhand des Codes selbst (`src/lib/i18n/errors.ts`).
- **Selbst gehostete Sync-Server** müssen nichts tun: Angezeigt wird ein Text der Extension zum Code (`ErrorCode` aus `protocol.ts`), nicht die `message` des Servers. Nur bei Codes, die die Extension nicht kennt, steht die Meldung des Servers gekürzt als Zusatz dahinter. Neue Codes also möglichst im Server-Repo in `protocol.ts` ergänzen.
- Links auf `app.synchrothek.de` tragen `?lang=de|en`; die Anmeldung (`/oauth2/authorize`) bekommt `lang` und `ui_locales`.

## Tokens

- Access- und Refresh-Token liegen nur im Hintergrundteil der Extension (IndexedDB der Extension, für Webseiten und Content-Scripts nicht erreichbar), nie in Popup oder Content-Scripts.
- Tokens gehen **ausschließlich** an die oben genannten offiziellen Adressen: `app.synchrothek.de` (Anmeldung), `api.synchrothek.de` (API), `sync.synchrothek.de` (Vermittler) und Knoten, deren Adresse genau `wss://<name>.sync.synchrothek.de` ist (ohne Port, Pfad, Zugangsdaten).
- **Nie an selbst gehostete Server**, nie in einer URL, nie über Weiterleitungen (`redirect: 'error'`), immer ohne Cookies.
- Ob ein Server offiziell ist, entscheidet allein seine fest eingebaute Adresse, nicht eine Angabe des Servers.

Datenschutzerklärung: <https://synchrothek.de/datenschutz> (englisch: <https://synchrothek.de/en/privacy>)
