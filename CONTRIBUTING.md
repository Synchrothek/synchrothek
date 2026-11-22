# Mitmachen

Beiträge sind willkommen: Fehlermeldungen, Verbesserungsvorschläge, Pull Requests. Für größere Änderungen bitte vorher ein Issue öffnen, damit wir die Richtung abstimmen können. Sicherheitslücken bitte nicht öffentlich melden, sondern wie in [SECURITY.md](SECURITY.md) beschrieben.

## Entwicklung

Siehe [README](README.md#entwicklung). Vor einem Pull Request bitte ausführen:

```sh
npm ci
npm run typecheck
npm test
npm run build && npm run build:firefox
```

Stil wie im Bestand: TypeScript, deutsche Oberfläche und Kommentare, keine Sendernamen im Namen oder Icon der Extension. Fremde Inhalte (Namen, Titel, Texte vom Server) nur als Text darstellen, nie als HTML. Tokens nur an die fest eingebauten offiziellen Adressen.

## Herkunftsnachweis (DCO)

Jeder Commit braucht eine Zeile `Signed-off-by: Name <E-Mail>` (`git commit -s`). Damit bestätigst du das [Developer Certificate of Origin 1.1](https://developercertificate.org/): Du hast das Recht, den Beitrag unter der Lizenz des Projekts einzureichen.

## Contributor-Vereinbarung (Nutzungsrechte)

> **Hinweis:** Dieser Abschnitt ist eine Contributor-Vereinbarung. Mit dem Einreichen eines Beitrags erklärst du dich mit ihm einverstanden.

Mit dem Einreichen eines Beitrags (z. B. Pull Request, Patch, Code, Text, Grafik) zu diesem Projekt

1. stellst du den Beitrag unter die Lizenz des Projekts (GNU Affero General Public License 3.0, nur diese Version), und
2. räumst du dem Projektinhaber (derzeit Tobias-Pascal Mildenberger) zusätzlich ein **einfaches, unbefristetes, weltweites, unentgeltliches und unwiderrufliches Nutzungsrecht** an deinem Beitrag ein. Es umfasst das Recht, den Beitrag zu vervielfältigen, zu bearbeiten, zu verbreiten, öffentlich zugänglich zu machen und **unter anderen Lizenzbedingungen (auch proprietären) zu lizenzieren (Relizenzierung)** sowie diese Rechte an Dritte weiterzugeben.
3. Du versicherst, dass du zur Einräumung dieser Rechte berechtigt bist (z. B. nicht durch Verpflichtungen gegenüber Arbeitgebern gehindert) und dass der Beitrag nach deinem Wissen keine Rechte Dritter verletzt.

Deine eigenen Rechte am Beitrag bleiben bestehen; du kannst ihn weiterhin selbst beliebig nutzen. Ein Anspruch auf Aufnahme oder Nennung besteht nicht; Beitragende werden in der Git-Historie genannt.

Wer mit dieser Vereinbarung nicht einverstanden ist, kann gern ein Issue mit einer Beschreibung des Problems oder Vorschlags öffnen, ohne Code einzureichen.
