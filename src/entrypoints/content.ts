/*
 * Synchrothek – Content-Script
 * Findet das <video>-Element des Mediathek-Players, meldet lokale Play/Pause/Seek-
 * Aktionen an den Hintergrund und wendet den Raumzustand auf den Player an.
 *
 * Der Raumzustand gilt nur für die Sendung des Raums (Vergleich über die URL).
 * Startet jemand im Raum-Tab eine andere Sendung, wechselt der Raum zu dieser Sendung.
 *
 * Für Weiterschauen meldet es Sendung und Position an den Hintergrund (gedrosselt). Ob davon
 * etwas gespeichert wird (Konto, Einwilligung), entscheidet allein der Hintergrund.
 */
import { browser, type Browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { MEDIATHEK_MATCHES } from '../lib/config';
import { sameContent } from '../lib/content-url';
import { formatPosition } from '../lib/time';
import { seriesFromJsonLd } from '../lib/series';
import { cleanTitle } from '../lib/title';
import type { FromContent, ProgressReason, RoomPlayback, ShowSnapshot, ToContent } from '../lib/messages';
import type { PlaybackAction } from '../lib/protocol';

const SEEK_TOLERANCE = 1.0; // s – kleinere Abweichungen gelten als „synchron“
const SYNC_TOLERANCE = 0.25; // s – beim ausdrücklichen „Sync zum Host“
const RESYNC_THRESHOLD = 2.0; // s – ab hier wird während der Wiedergabe nachgesprungen
const RESYNC_COOLDOWN_MS = 5000;
const OWN_SEEK_TTL_MS = 10_000;
const ATTACH_GRACE_MS = 15_000; // Autoplay/Fortsetzen durch den Player kurz nach dem Laden ignorieren
const COMMAND_WINDOW_MS = 2000; // Aktionen nach einem Popup-Befehl gelten als Nutzeraktion
const SCAN_INTERVAL_MS = 1000;
const HEARTBEAT_MS = 20_000;
const INFO_TOAST_MS = 6000;
const PROGRESS_INTERVAL_MS = 20_000; // Stand während der Wiedergabe melden (API: alle 15–30 s)
const RESUME_TOAST_MS = 12_000;
const RESUME_WAIT_MS = 5_000; // so lange höchstens auf die Antwort zu „Weiterschauen?“ warten

type ToastKind = 'play' | 'unmute' | 'info' | 'resume';

export default defineContentScript({
  matches: MEDIATHEK_MATCHES,
  allFrames: true,
  runAt: 'document_idle',
  main(ctx) {
    const marker = globalThis as { __synchrothekLoaded?: boolean };
    if (marker.__synchrothekLoaded) return;
    marker.__synchrothekLoaded = true;

    let video: HTMLVideoElement | null = null;
    let attachedAt = 0;
    let commandUntil = 0;
    let port: Browser.runtime.Port | null = null;
    let room: RoomPlayback | null = null;
    let ownSeek: { target: number; at: number } | null = null;
    let mutedByUs = false; // stumm geschaltet, weil der Browser Autoplay mit Ton blockiert hat
    let lastResync = 0;
    let lastUrl = location.href;
    let lastProgressAt = 0;
    let lastShow: ShowSnapshot | null = null; // zuletzt gesehener Stand, für das Verlassen der Seite
    // Solange „Weiterschauen ab …?“ offen ist, keinen Stand melden, der den gespeicherten überschreibt
    let resumeGate: { url: string; until: number; position: number | null } | null = null;

    // -----------------------------------------------------------------------
    // Video finden
    // -----------------------------------------------------------------------

    function collectVideos(root: Document | ShadowRoot, out: HTMLVideoElement[]) {
      for (const v of root.querySelectorAll('video')) out.push(v);
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collectVideos(el.shadowRoot, out);
      return out;
    }

    function pickVideo(): HTMLVideoElement | null {
      const videos = collectVideos(document, []);
      let best = videos[0] ?? null;
      let bestArea = 0;
      for (const v of videos) {
        const r = v.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
          best = v;
          bestArea = area;
        }
      }
      return best;
    }

    const handlers: [keyof HTMLMediaElementEventMap, () => void][] = [
      ['play', () => onLocal('play')],
      ['pause', () => onLocal('pause')],
      ['pause', () => video?.ended || reportProgress('pause')],
      ['ended', () => reportProgress('ended')],
      ['seeked', () => onLocal('seek')],
      ['volumechange', () => onVolumeChange()],
      ['loadedmetadata', () => applyRoomState()],
    ];

    function attach(v: HTMLVideoElement) {
      video = v;
      attachedAt = Date.now();
      mutedByUs = false;
      for (const [event, fn] of handlers) v.addEventListener(event, fn);
      ensurePort();
      post({ type: 'hello', url: location.href });
      applyRoomState();
      queryResume();
    }

    function detach() {
      if (!video) return;
      for (const [event, fn] of handlers) video.removeEventListener(event, fn);
      video = null;
      removeToast();
    }

    function tick() {
      if (!video || !video.isConnected) {
        const next = pickVideo();
        if (next !== video) {
          const had = !!video;
          detach();
          if (next) attach(next);
          else if (had) post({ type: 'video', present: false });
        }
      }
      if (location.href !== lastUrl) {
        // Navigation innerhalb einer Single-Page-App: neue Seite, neue Schonfrist
        if (lastShow?.url === lastUrl) reportProgress('leave', lastShow);
        lastShow = null;
        lastUrl = location.href;
        attachedAt = Date.now();
        post({ type: 'url', url: lastUrl });
        applyRoomState();
        if (video) queryResume();
      }
      maybeResync();
      trackProgress();
    }

    // -----------------------------------------------------------------------
    // Verbindung zum Hintergrund
    // -----------------------------------------------------------------------

    function ensurePort() {
      if (port || ctx.isInvalid) return;
      try {
        port = browser.runtime.connect({ name: 'content' });
      } catch {
        return; // Extension wurde neu geladen oder entfernt
      }
      port.onMessage.addListener((msg: ToContent) => onPortMessage(msg));
      port.onDisconnect.addListener(() => {
        port = null;
        if (ctx.isInvalid) return;
        // z. B. Service Worker neu gestartet: neu verbinden
        ctx.setTimeout(() => {
          if (!video) return;
          ensurePort();
          post({ type: 'hello', url: location.href });
        }, 500);
      });
    }

    function post(msg: FromContent) {
      if (!port) return;
      try {
        port.postMessage(msg);
      } catch {}
    }

    function onPortMessage(msg: ToContent) {
      switch (msg.type) {
        case 'state':
          room = { playing: msg.playing, position: msg.position, at: msg.at, urls: msg.urls };
          applyRoomState(msg.force ? SYNC_TOLERANCE : SEEK_TOLERANCE);
          break;
        case 'adopt':
          // Diese Sendung mit ihrem aktuellen Stand für den Raum übernehmen
          if (video) switchContent();
          break;
        case 'room':
          room = null;
          ownSeek = null;
          removeToast();
          break;
        case 'control':
          runControl(msg);
          break;
        case 'positionRequest':
          if (video && onRoomContent()) post({ type: 'position', position: video.currentTime, playing: !video.paused });
          break;
        case 'notice':
          showToast('info', msg.text);
          break;
        case 'resume':
          onResume(msg.url, msg.position);
          break;
        case 'seekTo':
          if (!video) break;
          commandUntil = Date.now() + COMMAND_WINDOW_MS; // gilt wie ein Sprung am Player
          video.currentTime = clampToVideo(msg.position);
          break;
        case 'snapshotRequest': {
          const snap = snapshot();
          if (snap) post({ type: 'snapshot', id: msg.id, ...snap });
          break;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Weiterschauen und Marker
    // -----------------------------------------------------------------------

    /** Lesbarer Titel der Sendung. In eingebetteten Frames leer: dann nimmt der Hintergrund den Tab-Titel. */
    function pageTitle(): string {
      if (window !== window.top) return '';
      const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? '';
      return cleanTitle(document.title || og);
    }

    /** Formatname (z. B. Serie) aus den strukturierten Daten der Seite (gefunden: je Adresse nur einmal gelesen). */
    let seriesCache: { url: string; series: string | null } | null = null;
    function pageSeries(): string | null {
      if (window !== window.top) return null;
      if (seriesCache?.url !== location.href || seriesCache.series === null) {
        const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent ?? '');
        seriesCache = { url: location.href, series: seriesFromJsonLd(blocks) };
      }
      return seriesCache.series;
    }

    function snapshot(): ShowSnapshot | null {
      if (!video || !Number.isFinite(video.currentTime)) return null;
      const d = video.duration;
      return {
        url: location.href,
        title: pageTitle(),
        series: pageSeries(),
        position: video.currentTime,
        duration: Number.isFinite(d) && d > 0 ? d : null,
      };
    }

    function clampToVideo(position: number): number {
      const d = video?.duration;
      const max = d !== undefined && Number.isFinite(d) && d > 0 ? d - 0.25 : Infinity;
      return Math.min(max, Math.max(0, position));
    }

    function reportProgress(reason: ProgressReason, snap = snapshot()) {
      if (!snap) return;
      if (resumeGate?.url === snap.url && Date.now() < resumeGate.until) return;
      lastProgressAt = Date.now();
      post({ type: 'progress', reason, ...snap });
    }

    /** Jede Sekunde: Stand merken, während der Wiedergabe alle 20 s melden. */
    function trackProgress() {
      if (!video || video.paused || video.seeking || video.readyState < 2) return;
      lastShow = snapshot();
      if (Date.now() - lastProgressAt >= PROGRESS_INTERVAL_MS) reportProgress('tick', lastShow);
    }

    function queryResume() {
      resumeGate = { url: location.href, until: Date.now() + RESUME_WAIT_MS, position: null };
      post({ type: 'resumeQuery', url: location.href });
    }

    function onResume(url: string, position: number | null) {
      if (!resumeGate || resumeGate.url !== url || url !== location.href) return;
      // Nichts gespeichert, oder der Player hat schon selbst dort weitergemacht
      if (position === null || !video || Math.abs(video.currentTime - position) < 10) {
        resumeGate = null;
        return;
      }
      resumeGate = { url, until: Date.now() + RESUME_TOAST_MS, position };
      showToast('resume', `▶ Synchrothek: Weiterschauen ab ${formatPosition(position)}?`);
    }

    function acceptResume() {
      const gate = resumeGate;
      resumeGate = null;
      if (!video || gate?.position == null || gate.url !== location.href) return;
      commandUntil = Date.now() + COMMAND_WINDOW_MS;
      video.currentTime = clampToVideo(gate.position);
      if (video.paused) startPlayback();
    }

    // -----------------------------------------------------------------------
    // Sync-Logik
    // -----------------------------------------------------------------------

    function onRoomContent(): boolean {
      return !!room && room.urls.some((url) => sameContent(location.href, url));
    }

    function expectedPosition(): number {
      if (!room) return 0;
      const pos = room.playing ? room.position + (Date.now() - room.at) / 1000 : room.position;
      const d = video?.duration;
      return d !== undefined && Number.isFinite(d) && d > 0 ? Math.min(pos, Math.max(0, d - 0.25)) : pos;
    }

    function seekTo(target: number) {
      if (!video) return;
      ownSeek = { target, at: Date.now() };
      video.currentTime = target;
    }

    function applyRoomState(tolerance = SEEK_TOLERANCE) {
      if (!video || !room || !onRoomContent()) return;
      if (video.readyState === 0) return; // erneuter Versuch bei loadedmetadata
      const target = expectedPosition();
      if (Math.abs(video.currentTime - target) > tolerance) seekTo(target);

      if (room.playing && video.paused && !video.ended) startPlayback();
      else if (!room.playing && !video.paused) video.pause();
    }

    function startPlayback() {
      const target = video;
      if (!target) return;
      target.play().then(
        () => {
          if (toastKind === 'play') removeToast();
        },
        (err: unknown) => {
          if ((err as Error)?.name !== 'NotAllowedError' || video !== target) return;
          if (target.muted) return showToast('play');
          // Ohne vorherige Interaktion erlauben Browser oft nur stummes Autoplay
          mutedByUs = true;
          target.muted = true;
          target.play().then(
            () => showToast('unmute'),
            () => {
              mutedByUs = false;
              target.muted = false;
              showToast('play');
            },
          );
        },
      );
    }

    /** Grobe Korrektur, falls ein Player deutlich abweicht (z. B. nach langem Puffern). */
    function maybeResync() {
      if (!room || !video || !onRoomContent() || video.seeking || video.readyState < 3) return;
      if (room.playing === video.paused) return;
      if (Date.now() - lastResync < RESYNC_COOLDOWN_MS) return;
      const target = expectedPosition();
      if (Math.abs(video.currentTime - target) > RESYNC_THRESHOLD) {
        lastResync = Date.now();
        seekTo(target);
      }
    }

    function isOwnSeek(pos: number): boolean {
      if (!ownSeek) return false;
      const fresh = Date.now() - ownSeek.at < OWN_SEEK_TTL_MS;
      const match = fresh && Math.abs(pos - ownSeek.target) < 0.5;
      if (match || !fresh) ownSeek = null;
      return match;
    }

    function userActive(): boolean {
      return Date.now() < commandUntil || (navigator.userActivation?.isActive ?? true);
    }

    function looksUserInitiated(): boolean {
      return Date.now() - attachedAt > ATTACH_GRACE_MS || userActive();
    }

    function onLocal(action: PlaybackAction) {
      if (!room || !video) return;
      if (action === 'pause' && video.ended) return;

      if (!onRoomContent()) {
        // Andere Sendung im Raum-Tab: Abspielen mit Ton oder nach einem Klick wechselt die
        // Sendung für alle. Stumm automatisch startende Vorschauvideos zählen nicht.
        if (action === 'play' && (!video.muted || userActive())) switchContent();
        return;
      }

      if (action === 'play' && toastKind === 'play') removeToast();

      const pos = video.currentTime;
      // Echos unserer eigenen Änderungen und Ereignisse ohne Zustandsänderung ignorieren
      if (action === 'play' && room.playing) return;
      if (action === 'pause' && !room.playing) return;
      if (action === 'seek' && (isOwnSeek(pos) || Math.abs(pos - expectedPosition()) <= SEEK_TOLERANCE)) return;

      // Autoplay oder Fortsetzen durch den Player direkt nach dem Laden: Raumzustand gewinnt
      if (!looksUserInitiated()) {
        applyRoomState();
        return;
      }

      const playing = action === 'play' ? true : action === 'pause' ? false : room.playing;
      room = { ...room, playing, position: pos, at: Date.now() };
      post({ type: 'local', action, position: pos });
    }

    function onVolumeChange() {
      if (!room || !video || video.muted) return;
      if (mutedByUs) {
        mutedByUs = false;
        if (toastKind === 'unmute') removeToast();
      }
      // Ein stumm gestartetes Video auf einer anderen Seite wird laut gestellt: Sendung wechseln
      if (!video.paused && !onRoomContent()) switchContent();
    }

    function switchContent() {
      if (!video) return;
      const position = video.currentTime;
      room = { playing: !video.paused, position, at: Date.now(), urls: [location.href] };
      post({ type: 'local', action: video.paused ? 'pause' : 'play', position, url: location.href });
    }

    /** Steuerbefehl aus dem Popup – wird wie eine Nutzeraktion am Player behandelt. */
    function runControl(msg: Extract<ToContent, { type: 'control' }>) {
      if (!video || !onRoomContent()) return;
      commandUntil = Date.now() + COMMAND_WINDOW_MS;
      if (msg.action === 'toggle') {
        if (video.paused) startPlayback();
        else video.pause();
      } else {
        const d = video.duration;
        const max = Number.isFinite(d) && d > 0 ? d - 0.25 : Infinity;
        video.currentTime = Math.min(max, Math.max(0, video.currentTime + msg.delta));
      }
    }

    // -----------------------------------------------------------------------
    // Hinweise im Player (Autoplay blockiert, Ton, Raum-Meldungen)
    // -----------------------------------------------------------------------

    const TOAST_TEXT: Record<Exclude<ToastKind, 'info' | 'resume'>, string> = {
      play: '▶ Synchrothek: Klicken, um synchron mitzuschauen',
      unmute: '🔇 Synchrothek: Klicken, um den Ton einzuschalten',
    };
    let toastHost: HTMLElement | null = null;
    let toastKind: ToastKind | null = null;
    let toastTimer: number | undefined;

    function showToast(kind: ToastKind, text?: string) {
      if (kind !== 'info' && kind !== 'resume' && toastKind === kind) return;
      // Hinweise zum Raum haben Vorrang vor „Weiterschauen?“
      if (kind === 'resume' && toastKind && toastKind !== 'resume') return;
      removeToast();
      toastKind = kind;
      toastHost = document.createElement('div');
      const shadow = toastHost.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `button{all:initial;position:fixed;z-index:2147483647;left:50%;bottom:32px;
        transform:translateX(-50%);max-width:min(90vw,560px);background:#1e40af;color:#fff;
        font:600 15px/1.3 system-ui,sans-serif;padding:12px 20px;border-radius:999px;cursor:pointer;
        box-shadow:0 6px 20px rgba(0,0,0,.4);text-align:center}
        button:hover{background:#1d4ed8}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent =
        kind === 'info' ? `Synchrothek: ${text ?? ''}` : kind === 'resume' ? (text ?? '') : TOAST_TEXT[kind];
      button.addEventListener('click', () => {
        removeToast();
        if (kind === 'unmute' && video) {
          mutedByUs = false;
          video.muted = false;
        } else if (kind === 'play') {
          applyRoomState();
        } else if (kind === 'resume') {
          acceptResume();
        }
      });
      shadow.append(style, button);
      const fs = document.fullscreenElement;
      const parent = fs && fs.tagName !== 'VIDEO' ? fs : (document.body ?? document.documentElement);
      parent.appendChild(toastHost);
      if (kind === 'info') toastTimer = ctx.setTimeout(removeToast, INFO_TOAST_MS);
      if (kind === 'resume') toastTimer = ctx.setTimeout(removeToast, RESUME_TOAST_MS);
    }

    function removeToast() {
      clearTimeout(toastTimer);
      toastHost?.remove();
      toastHost = null;
      toastKind = null;
    }

    // -----------------------------------------------------------------------

    ctx.setInterval(tick, SCAN_INTERVAL_MS);
    ctx.setInterval(() => {
      if (room) post({ type: 'heartbeat' });
    }, HEARTBEAT_MS);
    // Seite verlassen oder Tab geschlossen: letzten Stand melden
    ctx.addEventListener(window, 'pagehide', () => reportProgress('leave', snapshot() ?? lastShow));
    ctx.onInvalidated(() => {
      detach();
      port = null;
    });
    tick();
  },
});
