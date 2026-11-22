/**
 * End-to-End-Test: zwei bis drei Chromium-Profile mit geladener Extension (E2E-Build),
 * echter Synchrothek-Server, Mediathek-Seiten per Routing durch eine Testseite ersetzt.
 *
 *   npm run test:e2e      (baut die Extension im Modus „e2e“ und startet diesen Test)
 */
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXT = path.join(ROOT, '.output', 'chrome-mv3-e2e');
const VIDEO_PATH = path.join(ROOT, 'e2e', 'video.mp4');

// Server-Repo wird standardmäßig als Nachbarordner erwartet (../synchrothek-server)
const SERVER_DIR = path.resolve(process.env.SYNCHROTHEK_SERVER_DIR ?? path.join(ROOT, '..', 'synchrothek-server'));
const { startServer } = (await import(pathToFileURL(path.join(SERVER_DIR, 'src/server.ts')).href)) as {
  startServer: (o: object) => Promise<{ port: number; close(): Promise<void> }>;
};

if (!fs.existsSync(VIDEO_PATH)) {
  console.error('Testvideo fehlt – bitte `npm run e2e:setup` ausführen.');
  process.exit(1);
}
const VIDEO = fs.readFileSync(VIDEO_PATH);
const PAGE = `<!doctype html><title>Testsendung</title>
<video id="v" src="/video.mp4" width="640" height="360" muted playsinline></video>
<button id="play" onclick="v.play()">play</button>
<button id="pause" onclick="v.pause()">pause</button>
<button id="seek" onclick="v.currentTime = 60">seek</button>`;

// Im Service-Worker-Kontext ausgewertet
declare const chrome: { tabs: { query(q: object): Promise<{ id?: number }[]> } };

// Testzugang im Service Worker (nur im E2E-Build vorhanden)
declare const synchrothekTest: {
  state: Record<string, any>;
  ready: Promise<void>;
  command(tabId: number | null, cmd: object): Promise<void>;
};

const server = await startServer({ port: 0, host: '127.0.0.1' });
const wsUrl = `ws://127.0.0.1:${server.port}`;

interface User {
  ctx: BrowserContext;
  sw: Worker;
  page: Page;
  tabId: number;
  cmd(cmd: object): Promise<void>;
  state<T = any>(fn: string): Promise<T>;
}

async function user(name: string, { startUrl = 'https://www.zdf.de/testsendung' as string | null } = {}): Promise<User> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sync-${name}-`));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await ctx.route('https://www.zdf.de/**', (route) => {
    const req = route.request();
    if (!req.url().endsWith('/video.mp4')) return route.fulfill({ contentType: 'text/html', body: PAGE });
    const range = req.headers()['range'];
    if (!range) return route.fulfill({ status: 200, contentType: 'video/mp4', body: VIDEO, headers: { 'accept-ranges': 'bytes' } });
    const [, s, e] = range.match(/bytes=(\d+)-(\d*)/)!;
    const start = Number(s ?? 0);
    const end = e ? +e : VIDEO.length - 1;
    return route.fulfill({
      status: 206,
      contentType: 'video/mp4',
      body: VIDEO.subarray(start, end + 1),
      headers: { 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${VIDEO.length}` },
    });
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  await sw.evaluate(async ([url, n]) => {
    await synchrothekTest.ready;
    synchrothekTest.state.serverUrl = url;
    synchrothekTest.state.name = n;
  }, [wsUrl, name]);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  if (startUrl) await open(page, startUrl);
  const tabs = await sw.evaluate(async () => (await chrome.tabs.query({})).map((t: { id?: number }) => t.id!));
  if (tabs.length !== 1) throw new Error(`Erwartet genau einen Tab, gefunden: ${tabs.length}`);
  const tabId = tabs[0]!;
  return {
    ctx,
    sw,
    page,
    tabId,
    cmd: (cmd) => sw.evaluate(([t, c]) => synchrothekTest.command(t as number, c as object), [tabId, cmd] as const),
    state: (fn) => sw.evaluate((f) => new Function('s', `return (${f})(s)`)(synchrothekTest.state), fn),
  };
}

async function open(page: Page, url: string) {
  await page.goto(url);
  await videoReady(page);
}

async function videoReady(page: Page) {
  await page.waitForFunction(() => (document.getElementById('v') as HTMLVideoElement | null)?.readyState! >= 1);
}

const video = (p: Page) =>
  p.evaluate(() => {
    const v = document.getElementById('v') as HTMLVideoElement;
    return { paused: v.paused, t: +v.currentTime.toFixed(2) };
  });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => Promise<boolean>, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(100);
  }
  return false;
};

let failures = 0;
function check(label: string, cond: boolean, info?: unknown) {
  console.log(`${cond ? '✔' : '✘'} ${label}`, info ? JSON.stringify(info) : '');
  if (!cond) failures++;
}

const users: User[] = [];
try {
  const a = await user('Anna');
  const b = await user('Ben');
  users.push(a, b);

  // --- Grundfunktionen ------------------------------------------------------

  await a.cmd({ cmd: 'create' });
  await until(() => a.state('(s) => s.inRoom'));
  const code = await a.state<string>('(s) => s.code');
  check('A hat Raum erstellt und ist Host', /^[A-Z2-9]{6}$/.test(code) && (await a.state('(s) => s.info.hostId === s.memberId')), { code });

  await b.cmd({ cmd: 'join', code });
  await until(() => b.state('(s) => s.inRoom && s.info.members.length === 2'));
  const names = await a.state<string[]>('(s) => s.info.members.map((m) => m.name).sort()');
  check('B ist beigetreten, Namen sind sichtbar', names.join() === 'Anna,Ben', names);

  await a.page.click('#play');
  await wait(1500);
  let va = await video(a.page);
  let vb = await video(b.page);
  check('Play wird synchronisiert', !va.paused && !vb.paused && Math.abs(va.t - vb.t) < 1, { va, vb });

  await wait(1500);
  await b.page.click('#pause');
  await wait(800);
  va = await video(a.page);
  vb = await video(b.page);
  check('Pause von B kommt bei A an', va.paused && vb.paused && Math.abs(va.t - vb.t) < 0.5, { va, vb });

  await a.page.click('#seek');
  await wait(1000);
  va = await video(a.page);
  vb = await video(b.page);
  check('Seek wird synchronisiert', Math.abs(va.t - 60) < 0.5 && Math.abs(vb.t - 60) < 0.5 && va.paused && vb.paused, { va, vb });

  await b.page.click('#play');
  await wait(2000);
  va = await video(a.page);
  vb = await video(b.page);
  check('Play nach Seek', !va.paused && !vb.paused && Math.abs(va.t - vb.t) < 1 && va.t > 60, { va, vb });

  await b.page.reload();
  await videoReady(b.page);
  await wait(1500);
  va = await video(a.page);
  vb = await video(b.page);
  check('Nach Neuladen holt B den Raumzustand ein', !vb.paused && Math.abs(va.t - vb.t) < 1.5, { va, vb });

  await b.page.evaluate(() => setTimeout(() => (document.getElementById('v') as HTMLVideoElement).pause(), 6000));
  await wait(7000);
  va = await video(a.page);
  vb = await video(b.page);
  check('Pause ohne Nutzergeste in Schonfrist wird ignoriert', !va.paused && !vb.paused, { va, vb });

  // --- Steuerung im Popup und Sync zum Host ---------------------------------

  await b.cmd({ cmd: 'control', action: 'seek', delta: 10 });
  await wait(1200);
  va = await video(a.page);
  vb = await video(b.page);
  const before = va.t;
  check('Popup: +10 s von B springt bei allen', Math.abs(va.t - vb.t) < 1 && !va.paused, { va, vb });

  await b.cmd({ cmd: 'control', action: 'toggle' });
  await wait(800);
  va = await video(a.page);
  vb = await video(b.page);
  check('Popup: Pause von B pausiert alle', va.paused && vb.paused, { va, vb, before });

  await a.cmd({ cmd: 'control', action: 'toggle' });
  await wait(800);
  // B künstlich ~1 s hinterherlaufen lassen (unter der automatischen Korrekturgrenze)
  await b.page.evaluate(() => ((document.getElementById('v') as HTMLVideoElement).playbackRate = 0.5));
  await wait(2000);
  await b.page.evaluate(() => ((document.getElementById('v') as HTMLVideoElement).playbackRate = 1));
  const drift = Math.abs((await video(a.page)).t - (await video(b.page)).t);
  await b.cmd({ cmd: 'sync' });
  await wait(1000);
  va = await video(a.page);
  vb = await video(b.page);
  check('Sync zum Host gleicht Abweichung aus', drift > 0.7 && Math.abs(va.t - vb.t) < 0.4, { drift, va, vb });

  // --- Sendungswechsel und automatisches Folgen ------------------------------

  await open(a.page, 'https://www.zdf.de/folge-2');
  await a.page.click('#play');
  await b.page.waitForURL('**/folge-2', { timeout: 5000 }).catch(() => {});
  await videoReady(b.page);
  await wait(1500);
  va = await video(a.page);
  vb = await video(b.page);
  check('B folgt A zur neuen Sendung', b.page.url().endsWith('/folge-2') && !vb.paused && Math.abs(va.t - vb.t) < 1.5, { url: b.page.url(), va, vb });

  await open(a.page, 'https://www.zdf.de/uebersicht');
  await a.page.evaluate(() => setTimeout(() => (document.getElementById('v') as HTMLVideoElement).play(), 6000));
  await wait(7500);
  const roomUrl = await b.state<string>('(s) => s.playback.url');
  check('Stummes Vorschauvideo wechselt die Sendung nicht', roomUrl.endsWith('/folge-2') && b.page.url().endsWith('/folge-2'), { roomUrl });

  const c = await user('Carla', { startUrl: null });
  users.push(c);
  await c.cmd({ cmd: 'join', code });
  await c.page.waitForURL('**/folge-2', { timeout: 5000 }).catch(() => {});
  await videoReady(c.page);
  await wait(1500);
  vb = await video(b.page);
  let vc = await video(c.page);
  check('C landet aus leerem Tab direkt in der Sendung', c.page.url().endsWith('/folge-2') && !vc.paused && Math.abs(vb.t - vc.t) < 1.5, { url: c.page.url(), vb, vc });

  await c.sw.evaluate(() => {
    synchrothekTest.state.autoFollow = false;
  });
  await open(b.page, 'https://www.zdf.de/folge-3');
  await b.page.click('#play');
  await a.page.waitForURL('**/folge-3', { timeout: 5000 }).catch(() => {});
  await wait(1000);
  check('Ohne „Automatisch folgen“ bleibt C, A folgt', c.page.url().endsWith('/folge-2') && a.page.url().endsWith('/folge-3'), { a: a.page.url(), c: c.page.url() });
  await videoReady(a.page);
  await wait(1000);

  // --- Host-Funktionen ------------------------------------------------------

  await a.cmd({ cmd: 'updateSettings', controlMode: 'host' });
  await until(() => b.state('(s) => s.info.settings.controlMode === "host"'));
  await b.page.click('#pause');
  await wait(1200);
  va = await video(a.page);
  vb = await video(b.page);
  check('„Nur Host steuert“: Pause von B wird zurückgenommen', !va.paused && !vb.paused, { va, vb });
  await a.cmd({ cmd: 'updateSettings', controlMode: 'all' });

  const carlaId = await c.state<string>('(s) => s.memberId');
  await a.cmd({ cmd: 'kick', memberId: carlaId, ban: false });
  await until(() => c.state('(s) => !s.inRoom'));
  check('Kicken entfernt C', !(await c.state('(s) => s.inRoom')) && (await a.state('(s) => s.info.members.length')) === 2, await c.state('(s) => s.notice'));

  await c.cmd({ cmd: 'join', code });
  await until(() => c.state('(s) => s.inRoom'));
  const carlaId2 = await c.state<string>('(s) => s.memberId');
  await a.cmd({ cmd: 'kick', memberId: carlaId2, ban: true });
  await until(() => c.state('(s) => !s.inRoom'));
  await c.cmd({ cmd: 'join', code });
  await until(() => c.state('(s) => s.notice?.kind === "error" && !s.code'));
  check('Bannen: C kommt nicht wieder rein', !(await c.state('(s) => s.inRoom')), await c.state('(s) => s.notice'));

  const benId = await b.state<string>('(s) => s.memberId');
  await a.cmd({ cmd: 'leave' });
  await until(() => b.state(`(s) => s.info.hostId === "${benId}"`));
  check('Host verlässt Raum: B wird Host', (await b.state('(s) => s.info.hostId === s.memberId')) && (await b.state('(s) => s.info.members.length')) === 1);
} finally {
  for (const u of users) await u.ctx.close().catch(() => {});
  await server.close();
}
console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : '\nAlle Prüfungen bestanden');
process.exit(failures ? 1 : 0);
