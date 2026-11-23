# Changelog

## 0.6.0 – unveröffentlicht

- **Englische Oberfläche:** Popup, Hinweise, Benachrichtigungen und Hinweise im Player gibt es auf Deutsch und Englisch. Die Sprache folgt dem Browser (Deutsch, wenn die bevorzugte Sprache mit `de` beginnt, sonst Englisch) und lässt sich in den Einstellungen unter *Sprache* festlegen (*Automatisch*, *Deutsch*, *English*); der Wechsel wirkt sofort. Name und Beschreibung im Manifest kommen aus `_locales` (Englisch für alle anderen Sprachen).
- Plattform-API: Jede Anfrage sendet `Accept-Language` mit der Sprache der Oberfläche; Meldungen und Einwilligungstexte kommen in dieser Sprache, nach einem Sprachwechsel werden die Einwilligungstexte neu geladen.
- Fehler von Vermittler und Sync-Server werden anhand ihrer Codes in der Extension übersetzt statt die Meldung des Servers anzuzeigen; unbekannte Codes zeigen einen allgemeinen Text mit gekürzter Servermeldung als Zusatz. Ob `rate_limited` die Antwort auf `auth` ist, entscheidet jetzt ein Zähler statt des Meldungstexts.
- Links auf `app.synchrothek.de` tragen `?lang=de|en`, Links auf die Website führen zu den Seiten der Sprache (`/en/privacy` …). Die Anmeldung übergibt die Sprache (`lang`, `ui_locales`).
- Datum, Uhrzeit, Dauer und Mehrzahl je Sprache (`Intl`). Der automatische Gastname heißt auf Englisch „Guest …“.
- **Anmeldung im Tab:** Der Login mit Synchrothek-Konto öffnet einen normalen Tab neben dem aktuellen (statt des kleinen Fensters von `identity.launchWebAuthFlow`). Passwort-Manager, Passkeys, die Bestätigungsmail und Wechsel zwischen Tabs funktionieren dort wie gewohnt. Redirect-URI ist die Seite `https://app.synchrothek.de/extension/verbunden`; ein eigenes Content-Script nur für diese Seite liest `code`, `state`, `iss` bzw. `error` aus der Adresse und gibt sie an den Hintergrund, der Absender (eigene Extension, oberster Frame, genau diese Seite, Tab der Anmeldung), `state` und `iss` prüft und den Code mit dem PKCE-Verifier eintauscht. Danach schließt sich der Tab, der vorherige Tab wird wieder aktiv. Keine neue Berechtigung.
- Die offene Anmeldung (Verifier, State, Tab) liegt in `storage.session` und übersteht einen Neustart des Hintergrunds; sie gilt 15 Minuten und genau einmal. Eine neue Anmeldung ersetzt die offene, Schließen des Tabs bricht ab. Im Popup: „Anmeldung läuft im geöffneten Tab …“ mit *Neu starten*.
- Fehler der Anmeldung getrennt: abgebrochen, abgelaufen, nicht erreichbar bzw. Zeitüberschreitung und Fehler der Plattform (jeweils mit *Erneut versuchen*; der Code-Tausch wird einmal automatisch wiederholt), Antwort passt zu keiner offenen Anmeldung, unerwarteter Aussteller.
- Rückfall: Ohne Zugriff auf `app.synchrothek.de` (Firefox: Berechtigung entzogen) oder wenn kein Tab geöffnet werden kann, läuft die Anmeldung wie bisher im Fenster von `identity.launchWebAuthFlow`, ebenfalls mit gespeicherter offener Anmeldung.
- Einstellungen → Server: eigener Knopf *Speichern* (und Enter) auf der Unterseite.

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
