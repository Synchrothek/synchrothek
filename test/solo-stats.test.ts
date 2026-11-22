/**
 * Tests für die Zählung beim alleine Schauen (src/lib/solo-stats.ts) mit nachgebildeter Uhr.
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SoloStatsReport } from '../src/lib/api.ts';
import { createSoloStats, SOLO_STATS } from '../src/lib/solo-stats.ts';

const URL_A = 'https://www.zdf.de/serien/beispiel/folge-1-100.html';
const URL_B = 'https://www.zdf.de/serien/beispiel/folge-2-100.html';

function setup() {
  let clock = Date.parse('2026-11-21T19:00:00.000Z');
  const reports: SoloStatsReport[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const stats = createSoloStats({
    report: async (r) => {
      reports.push(r);
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
  });
  /** Uhr vorstellen und fällige Timer auslösen. */
  const advance = (ms: number) => {
    clock += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= clock) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  /** Wiedergabe mit `tick` alle 20 s über `seconds`. */
  const play = (key: number, url: string, seconds: number) => {
    stats.tick(key, url);
    for (let t = 20; t <= seconds; t += 20) {
      advance(20_000);
      stats.tick(key, url);
    }
  };
  return { stats, reports, advance, play, now: () => clock };
}

test('zählt laufende Wiedergabe und meldet beim Ende', () => {
  const { stats, reports, play } = setup();
  play(1, URL_A, 120);
  assert.equal(reports.length, 0); // nur im Speicher
  stats.end(1);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.url, URL_A);
  assert.equal(reports[0]!.seconds, 120);
  assert.equal(reports[0]!.startedAt, '2026-11-21T19:00:00.000Z');
});

test('Abschnitte unter 30 s werden verworfen', () => {
  const { stats, reports, play } = setup();
  play(1, URL_A, 20);
  stats.end(1);
  assert.equal(reports.length, 0);
});

test('Pause hält die Zeit an; lange Pause schließt den Abschnitt ab', () => {
  const { stats, reports, play, advance } = setup();
  play(1, URL_A, 60);
  stats.pause(1);
  advance(60_000); // kurze Pause: nichts gemeldet, zählt nicht
  assert.equal(reports.length, 0);
  play(1, URL_A, 40);
  stats.pause(1);
  advance(SOLO_STATS.longPauseMs);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.seconds, 100); // 60 + 40, ohne die Pause
});

test('spätestens alle 10 Minuten laufender Wiedergabe eine Meldung', () => {
  const { stats, reports, play } = setup();
  play(1, URL_A, 25 * 60);
  assert.equal(reports.length, 2);
  assert.ok(reports.every((r) => r.seconds === SOLO_STATS.flushAfterSeconds));
  stats.end(1);
  assert.equal(reports.length, 3);
  assert.equal(reports[2]!.seconds, 5 * 60);
});

test('Sendungswechsel im Tab schließt den alten Abschnitt ab', () => {
  const { stats, reports, play } = setup();
  play(1, URL_A, 60);
  play(1, URL_B, 60);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.url, URL_A);
  stats.end(1);
  assert.equal(reports[1]!.url, URL_B);
});

test('ohne Lebenszeichen zählt die Wiedergabe nur kurz weiter (z. B. Ruhezustand)', () => {
  const { stats, reports, play, advance } = setup();
  play(1, URL_A, 60);
  advance(30 * 60_000); // keine ticks
  stats.end(1);
  assert.equal(reports[0]!.seconds, 60 + SOLO_STATS.heartbeatGraceMs / 1000);
});

test('Tabs werden getrennt gezählt; clear verwirft ohne zu melden', () => {
  const { stats, reports, play } = setup();
  play(1, URL_A, 60);
  play(2, URL_B, 60);
  stats.clear();
  stats.endAll();
  assert.equal(reports.length, 0);
});

test('höchstens 50 Meldungen pro Stunde', () => {
  const { stats, reports, play } = setup();
  for (let i = 0; i < 60; i++) {
    play(1, i % 2 ? URL_A : URL_B, 40);
    stats.end(1);
  }
  assert.equal(reports.length, SOLO_STATS.maxReportsPerHour);
});
