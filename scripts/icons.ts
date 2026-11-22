/**
 * Erzeugt die Extension-Icons (public/icon/<größe>.png) und das Store-Icon (store/icon-128.png)
 * aus dem Logo im Popup (.logo in popup/style.css):
 * gefülltes Quadrat in Akzentfarbe oben links, umrandetes Quadrat unten rechts.
 * Auf dunkler Kachel (Farben des dunklen Popups), damit es in hellen und dunklen Toolbars lesbar ist.
 *   npm run icons     # braucht Playwright-Chromium (npm run e2e:setup)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'public', 'icon');
const storeDir = path.join(root, 'store');

const TILE = '#1c1b19';
const ACCENT = '#e0a526';
const INK = '#edebe6';

/**
 * `pad`: transparenter Rand. Manifest-Icon 128 mit 8 px, kleine Toolbar-Icons randlos für maximale Größe.
 * Store-Icon (Chrome Web Store, AMO): 128 × 128 mit 16 px Rand, also 96 × 96 Motiv.
 */
function svg(size: number, pad = size >= 128 ? size / 16 : 0): string {
  const tile = size - 2 * pad;
  // Logo im Popup: 18×18-Feld, Quadrate 12×12, Radius 3, Rand 1,5
  const logo = tile * 0.64;
  const unit = logo / 18;
  const sq = 12 * unit;
  const radius = 3 * unit;
  // Rand bei kleinen Größen mindestens ~1,25 px, sonst verschwindet er
  const stroke = Math.max(1.5 * unit, size <= 16 ? 1.25 : 0);
  const o = pad + (tile - logo) / 2;
  const far = o + logo - sq;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="${pad}" y="${pad}" width="${tile}" height="${tile}" rx="${tile * 0.22}" fill="${TILE}"/>
  <rect x="${o}" y="${o}" width="${sq}" height="${sq}" rx="${radius}" fill="${ACCENT}"/>
  <rect x="${far + stroke / 2}" y="${far + stroke / 2}" width="${sq - stroke}" height="${sq - stroke}"
        rx="${Math.max(radius - stroke / 2, 0)}" fill="none" stroke="${INK}" stroke-width="${stroke}"/>
</svg>`;
}

const targets = [
  ...[16, 32, 48, 128].map((size) => ({ size, pad: undefined as number | undefined, file: path.join(outDir, `${size}.png`) })),
  { size: 128, pad: 16, file: path.join(storeDir, 'icon-128.png') },
];

mkdirSync(outDir, { recursive: true });
mkdirSync(storeDir, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { size, pad, file } of targets) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg(size, pad)}`);
    const png = await page.locator('svg').screenshot({ omitBackground: true });
    writeFileSync(file, png);
    console.log(path.relative(root, file));
  }
} finally {
  await browser.close();
}
