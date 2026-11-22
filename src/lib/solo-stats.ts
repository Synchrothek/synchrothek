/**
 * Statistik beim alleine Schauen: Zuschauzeit je Tab nur im Speicher sammeln und gesammelt melden
 * (POST /v1/stats/solo). Gemeinsam in Räumen misst der Sync-Server, nicht die Extension.
 *
 * Vorgaben der Plattform, sparsam umgesetzt:
 * - Gezählt wird nur laufende Wiedergabe. Das Content-Script meldet während der Wiedergabe etwa alle
 *   20 s einen Stand (`tick`), bei Pause, Ende und Verlassen der Seite sofort. Die Zeit bis zum ersten
 *   `tick` nach dem Start zählt nicht (lieber zu wenig als zu viel).
 * - Gemeldet wird beim Ende, beim Verlassen der Seite, beim Wechsel der Sendung oder in einen Raum,
 *   nach längerer Pause und spätestens alle 10 Minuten laufender Wiedergabe.
 * - Abschnitte unter 30 s werden verworfen statt gesendet; höchstens 50 Meldungen pro Stunde.
 * - Ob überhaupt gezählt wird (Kontext „allein“, Einwilligungen), entscheidet der Aufrufer.
 *
 * Ohne Abhängigkeit von `browser`, damit sich das Modul unter Node testen lässt (test/solo-stats.test.ts).
 */
import type { SoloStatsReport } from './api.ts';

export const SOLO_STATS = {
  minSeconds: 30,
  flushAfterSeconds: 10 * 60, // spätestens so viel laufende Wiedergabe in einer Meldung
  longPauseMs: 3 * 60_000, // so lange Pause: Abschnitt abschließen
  heartbeatGraceMs: 45_000, // ohne `tick` gilt die Wiedergabe höchstens so lange als weiterlaufend
  maxReportsPerHour: 50, // Plattform: höchstens 60
} as const;

export interface SoloStatsDeps {
  /** Meldung senden. Fehler werden verworfen (kein erneuter Versuch, nichts wird lokal gespeichert). */
  report(report: SoloStatsReport): Promise<unknown>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

interface Segment {
  url: string;
  startedAt: number;
  seconds: number; // abgeschlossene Wiedergabezeit
  runningSince: number | null;
  lastSeen: number;
  pauseTimer: unknown;
}

export function createSoloStats(deps: SoloStatsDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const segments = new Map<number, Segment>();
  let sentAt: number[] = [];

  /** Laufende Wiedergabe in die Summe übernehmen (höchstens bis kurz nach dem letzten Lebenszeichen). */
  function stopRunning(seg: Segment, at = now()) {
    if (seg.runningSince === null) return;
    const end = Math.min(at, seg.lastSeen + SOLO_STATS.heartbeatGraceMs);
    seg.seconds += Math.max(0, end - seg.runningSince) / 1000;
    seg.runningSince = null;
  }

  function total(seg: Segment, at = now()): number {
    const running = seg.runningSince === null ? 0 : Math.max(0, Math.min(at, seg.lastSeen + SOLO_STATS.heartbeatGraceMs) - seg.runningSince);
    return seg.seconds + running / 1000;
  }

  function send(url: string, seconds: number, startedAt: number) {
    if (seconds < SOLO_STATS.minSeconds) return;
    const t = now();
    sentAt = sentAt.filter((s) => t - s < 3_600_000);
    if (sentAt.length >= SOLO_STATS.maxReportsPerHour) return; // sehr unwahrscheinlich, dann lieber verwerfen
    sentAt.push(t);
    deps.report({ url, seconds: Math.round(seconds), startedAt: new Date(startedAt).toISOString() }).catch(() => {});
  }

  /** Abschnitt des Tabs abschließen und (ab 30 s) melden. */
  function end(key: number) {
    const seg = segments.get(key);
    if (!seg) return;
    clearTimer(seg.pauseTimer);
    stopRunning(seg);
    segments.delete(key);
    send(seg.url, seg.seconds, seg.startedAt);
  }

  /** Wiedergabe läuft gerade (Lebenszeichen etwa alle 20 s). */
  function tick(key: number, url: string) {
    const t = now();
    let seg = segments.get(key);
    if (seg && seg.url !== url) {
      end(key); // andere Sendung im selben Tab
      seg = undefined;
    }
    if (!seg) {
      segments.set(key, { url, startedAt: t, seconds: 0, runningSince: t, lastSeen: t, pauseTimer: null });
      return;
    }
    clearTimer(seg.pauseTimer);
    seg.pauseTimer = null;
    if (seg.runningSince !== null && t - seg.lastSeen > SOLO_STATS.heartbeatGraceMs) {
      stopRunning(seg, t); // Lücke (z. B. Rechner im Ruhezustand): nur bis kurz nach dem letzten Lebenszeichen
    }
    if (seg.runningSince === null) seg.runningSince = t;
    seg.lastSeen = t;
    if (total(seg, t) >= SOLO_STATS.flushAfterSeconds) {
      // Spätestens alle 10 Minuten melden, danach mit neuem Abschnitt weiterzählen
      end(key);
      segments.set(key, { url, startedAt: t, seconds: 0, runningSince: t, lastSeen: t, pauseTimer: null });
    }
  }

  /** Pause: Zeit anhalten; dauert die Pause länger, wird der Abschnitt abgeschlossen. */
  function pause(key: number) {
    const seg = segments.get(key);
    if (!seg) return;
    stopRunning(seg);
    clearTimer(seg.pauseTimer);
    seg.pauseTimer = setTimer(() => end(key), SOLO_STATS.longPauseMs);
  }

  /** Alle Abschnitte abschließen und melden (z. B. Raum betreten). */
  function endAll() {
    for (const key of [...segments.keys()]) end(key);
  }

  /** Alles verwerfen, ohne zu melden (Einwilligung weg, abgemeldet). */
  function clear() {
    for (const seg of segments.values()) clearTimer(seg.pauseTimer);
    segments.clear();
  }

  return { tick, pause, end, endAll, clear, has: (key: number) => segments.has(key) };
}

export type SoloStats = ReturnType<typeof createSoloStats>;
