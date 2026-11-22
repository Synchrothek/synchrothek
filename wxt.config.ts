import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { API_HOST_MATCH, AUTH_HOST_MATCH, MEDIATHEK_MATCHES } from './src/lib/config';

// Öffentlicher Schlüssel der Chrome-Web-Store-Version (Extension-ID ogecioeoilcegakfimcfnlojjnnponmn, aus dem
// Developer Dashboard: „Paket“ → „Öffentlichen Schlüssel ansehen“). Damit haben Entwicklungs- und Test-Builds
// dieselbe ID wie die Store-Version; deren OAuth-Redirect-URI https://<id>.chromiumapp.org/ ist auf der Plattform
// eingetragen. Der private Schlüssel liegt nur beim Chrome Web Store.
//
// Nur in Entwicklungs- und Test-Builds (`wxt`, `--mode e2e`) oder mit CHROME_KEY_IN_MANIFEST=1 im Manifest,
// nicht im ZIP für den Chrome Web Store (dort ist die ID ohnehin festgelegt).
const CHROME_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmFhJwkZBSCPibGEeWlZaBKlzurHlxJ/M++KQJpwIhlovJVXtlCH+m4puDsDcBWGA2J9rcUsbk+1AyLH4ON19+O5JJUs2deRDySC1JnM1ozZ3QvPnqBwPjnfzoI9HH/CWHOSA1MuDx+ZijJ4kXi5JgEeLU+R7nogUiSkObFdk+siq6f/dkRnlEJZWd0keBSU89D10pxeeeTlqMZ3nBjnBfCWq3SBpRTzuyMtfzsV9bjjpedrzdIntSi5cg5OERrlBM2px8wvpztxj2hcK/dNJtV8AjgcEH+JYJdcuCOZETOkZlaUA4SCFgYxbeNEVhfQZsncuqPaS0eyCHb3RPqyk8QIDAQAB';

/** `key` (feste Chrome-ID) nur beim Entwickeln, im Testbuild oder ausdrücklich per Umgebungsvariable. */
function withChromeKey({ mode, command }: { mode: string; command: string }): boolean {
  return command === 'serve' || mode === 'development' || mode === 'e2e' || process.env.CHROME_KEY_IN_MANIFEST === '1';
}

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  imports: false, // explizite Imports statt automatischer globaler Funktionen
  manifestVersion: 3,
  hooks: {
    // Lizenztext (AGPL-3.0-only) in jeden Build und damit in die ZIPs für die Stores legen
    'build:publicAssets': (_wxt, files) => {
      files.push({ absoluteSrc: fileURLToPath(new URL('./LICENSE', import.meta.url)), relativeDest: 'LICENSE' });
      // Schrift IBM Plex im Popup (SIL Open Font License 1.1): Lizenz muss mit den Schriftdateien mitkommen
      for (const font of ['ibm-plex-sans', 'ibm-plex-mono']) {
        files.push({
          absoluteSrc: fileURLToPath(new URL(`./node_modules/@fontsource/${font}/LICENSE`, import.meta.url)),
          relativeDest: `fonts/${font}-OFL.txt`,
        });
      }
    },
  },
  zip: {
    // Quellen-ZIP für die Prüfung auf addons.mozilla.org: ohne Testvideo (versteckte Ordner wie .keys/ fehlen ohnehin)
    excludeSources: ['e2e/video.mp4', 'store/**'],
  },
  manifest: ({ browser, mode, command }) => ({
    name: 'Synchrothek',
    // Höchstens 132 Zeichen, ohne Sendernamen (Marken)
    description:
      'Öffentlich-rechtliche Mediatheken gemeinsam schauen: Play, Pause und Position synchron – jede Person im offiziellen Player.',
    homepage_url: 'https://synchrothek.de',
    // alarms: Einladungen in Räume regelmäßig abfragen; notifications: Einladung anzeigen
    permissions: ['storage', 'identity', 'alarms', 'notifications'],
    // Mediatheken: für Content-Scripts und um beim automatischen Folgen die URL des Raum-Tabs zu lesen.
    // Plattform: Token-, Widerrufs- und Profil-Endpunkt für den Login mit Synchrothek-Konto.
    // API: Weiterschauen und Marker (nur aus dem Background, die API sendet bewusst keine CORS-Header).
    host_permissions: [...MEDIATHEK_MATCHES, AUTH_HOST_MATCH, API_HOST_MATCH],
    action: { default_title: 'Synchrothek' },
    ...(browser !== 'firefox' && {
      // action.openPopup() (Klick auf die Benachrichtigung einer Einladung) gibt es ohne Richtlinie erst ab Chrome 127
      minimum_chrome_version: '127',
      ...(withChromeKey({ mode, command }) && { key: CHROME_KEY }),
    }),
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'synchrothek@synchrothek.de',
          // data_collection_permissions gibt es ab Firefox 140
          strict_min_version: '140.0',
          // Was die Extension überträgt (README, Abschnitt „Datenübertragung (Firefox)“):
          // - personallyIdentifyingInfo: Anzeigename im Raum, Benutzername des Kontos
          // - browsingActivity: Adressen der geschauten Sendungen (Raum, Weiterschauen, Marker, Statistik)
          // - websiteActivity: Play, Pause und Position im Player
          // - websiteContent: Titel und Formatname der Sendung, Marker-Notizen
          // - authenticationInfo: Anmelde-Token an die offizielle Plattform und den offiziellen Sync-Dienst
          data_collection_permissions: {
            required: ['personallyIdentifyingInfo', 'browsingActivity', 'websiteActivity', 'websiteContent', 'authenticationInfo'],
          },
        },
        // Firefox für Android kennt data_collection_permissions erst ab 142 (sonst Warnung von web-ext lint)
        gecko_android: { strict_min_version: '142.0' },
      },
    }),
  }),
});
