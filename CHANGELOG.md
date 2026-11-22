# Changelog

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
