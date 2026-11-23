# Changelog

## 0.6.0 – unveröffentlicht

- **Englische Oberfläche:** Popup, Hinweise, Benachrichtigungen und Hinweise im Player gibt es auf Deutsch und Englisch. Die Sprache folgt dem Browser (Deutsch, wenn die bevorzugte Sprache mit `de` beginnt, sonst Englisch) und lässt sich in den Einstellungen unter *Sprache* festlegen (*Automatisch*, *Deutsch*, *English*); der Wechsel wirkt sofort. Name und Beschreibung im Manifest kommen aus `_locales` (Englisch für alle anderen Sprachen).
- Plattform-API: Jede Anfrage sendet `Accept-Language` mit der Sprache der Oberfläche; Meldungen und Einwilligungstexte kommen in dieser Sprache, nach einem Sprachwechsel werden die Einwilligungstexte neu geladen.
- Fehler von Vermittler und Sync-Server werden anhand ihrer Codes in der Extension übersetzt statt die Meldung des Servers anzuzeigen; unbekannte Codes zeigen einen allgemeinen Text mit gekürzter Servermeldung als Zusatz. Ob `rate_limited` die Antwort auf `auth` ist, entscheidet jetzt ein Zähler statt des Meldungstexts.
- Links auf `app.synchrothek.de` tragen `?lang=de|en`, Links auf die Website führen zu den Seiten der Sprache (`/en/privacy` …). Die Anmeldung übergibt die Sprache (`lang`, `ui_locales`).
- Datum, Uhrzeit, Dauer und Mehrzahl je Sprache (`Intl`). Der automatische Gastname heißt auf Englisch „Guest …“.

## 0.5.0 – 2026-11-21

- **Allein-Modus:** Weiterschauen, Marker und Statistik auch beim alleine Schauen, je Funktion mit eigenem Schalter „Auch beim alleine Schauen“ und eigener Einwilligung (Standard aus). Getrennte Sammlungen „gemeinsam“/„allein“, Statistik allein misst die Extension selbst (`POST /v1/stats/solo`, gesammelt und sparsam), „Allein-Daten löschen“.
- Einwilligungsdialog: Link zur Datenschutzerklärung, gleichwertige Knöpfe „Einwilligen“ und „Nicht jetzt“, neue Fassungen eines Einwilligungstexts werden erkannt und angeboten.
- Formatname (z. B. Serie) wird bei Weiterschauen und Markern mitgesendet, wenn die Seite ihn angibt.
- Sicherheit: Raum-Tab wird nur zu Seiten der unterstützten Mediatheken geführt; Absender von Popup- und Content-Ports werden geprüft; `iss`-Prüfung beim Login (RFC 9207).
- Wiederverbinden: nach mehreren Fehlversuchen fragt die Extension den Vermittler nach dem Knoten des Raums; existiert der Raum nicht mehr, wird er sauber beendet. Beitreten bei gestörtem Vermittler: „Erneut versuchen“.
- Name im Raum: Der Konto-Name ist nur noch ein Vorschlag und lässt sich ändern.
- Texte für das Schließen eines Raums je Grund, Update-Hinweis passend für Store-Installationen.
- Store-Reife: Beschreibung, Homepage, `minimum_chrome_version` 127, Firefox ab 140 mit `data_collection_permissions`; `key` nur noch in Entwicklungs- und Testbuilds; Store-Icon.
- Projekt: CI mit Unit-Tests und auf Commit-SHA festgelegten Actions, Dependabot, SECURITY.md, CONTRIBUTING.md, Übersicht der offiziellen Dienste.

## 0.4.0

- Knoten-Pool (Vermittler, Tickets), Profilbilder, Client-Konfiguration, Kontosperre.
