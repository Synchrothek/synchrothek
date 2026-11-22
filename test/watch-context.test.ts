/**
 * Tests für die Entscheidung gemeinsam/allein und die Einwilligungen (src/lib/watch-context.ts).
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Consent, ConsentEntry, Purpose } from '../src/lib/api.ts';
import {
  basePurposeOf,
  canOfferSolo,
  contextFor,
  isOutdated,
  isSoloPurpose,
  mayRead,
  mayWrite,
  soloPurposeOf,
  worthReading,
} from '../src/lib/watch-context.ts';

const entry = (granted: boolean, extra: Partial<ConsentEntry> = {}): ConsentEntry => ({
  granted,
  version: granted ? '2026-11-19' : null,
  grantedAt: granted ? '2026-11-19T19:20:00.000Z' : null,
  currentVersion: '2026-11-19',
  title: 'T',
  text: 'Text',
  requires: null,
  ...extra,
});

function consent(granted: Purpose[]): Consent {
  const all: Purpose[] = ['watch_progress', 'markers', 'statistics', 'watch_progress_solo', 'markers_solo', 'statistics_solo'];
  return Object.fromEntries(all.map((p) => [p, entry(granted.includes(p))]));
}

test('Kontext: gemeinsam nur im Raum-Tab eines bestätigten Raums auf dem offiziellen Server', () => {
  assert.equal(contextFor({ inRoom: true, official: true, roomTab: true }), 'room');
  assert.equal(contextFor({ inRoom: true, official: true, roomTab: false }), 'solo'); // anderer Tab
  assert.equal(contextFor({ inRoom: false, official: true, roomTab: true }), 'solo'); // kein Raum
  assert.equal(contextFor({ inRoom: true, official: false, roomTab: true }), 'solo'); // selbst gehostet
});

test('Gemeinsam reicht die Haupteinwilligung', () => {
  const c = consent(['watch_progress']);
  assert.equal(mayWrite(c, 'watch_progress', 'room'), true);
  assert.equal(mayWrite(c, 'markers', 'room'), false);
});

test('Allein nur mit Haupt- und Zusatz-Einwilligung, sonst nichts senden', () => {
  assert.equal(mayWrite(consent(['watch_progress']), 'watch_progress', 'solo'), false);
  assert.equal(mayWrite(consent(['watch_progress', 'watch_progress_solo']), 'watch_progress', 'solo'), true);
  // Zusatz-Einwilligung allein genügt nie
  assert.equal(mayWrite(consent(['watch_progress_solo']), 'watch_progress', 'solo'), false);
  assert.equal(mayWrite(consent(['statistics', 'statistics_solo']), 'statistics', 'solo'), true);
  assert.equal(mayWrite(consent(['statistics', 'markers_solo']), 'statistics', 'solo'), false);
});

test('Ohne bekannten Einwilligungsstand wird nichts gesendet', () => {
  assert.equal(mayWrite(null, 'watch_progress', 'room'), false);
  assert.equal(mayWrite(undefined, 'markers', 'solo'), false);
  assert.equal(mayWrite({}, 'statistics', 'room'), false); // Zweck der Plattform unbekannt
});

test('Lesen braucht nur die Haupteinwilligung; „allein“ ohne Zusatz-Einwilligung gar nicht erst lesen', () => {
  const c = consent(['markers']);
  assert.equal(mayRead(c, 'markers'), true);
  assert.equal(worthReading(c, 'markers', 'room'), true);
  assert.equal(worthReading(c, 'markers', 'solo'), false);
  assert.equal(worthReading(consent(['markers', 'markers_solo']), 'markers', 'solo'), true);
});

test('Zusatz-Einwilligung nur anbieten, wenn die Haupteinwilligung besteht und die Plattform sie kennt', () => {
  assert.equal(canOfferSolo(consent(['statistics']), 'statistics'), true);
  assert.equal(canOfferSolo(consent([]), 'statistics'), false);
  assert.equal(canOfferSolo({ statistics: entry(true) }, 'statistics'), false); // ältere Plattform
});

test('Zwecke: Zuordnung Haupt- und Zusatz-Einwilligung', () => {
  assert.equal(soloPurposeOf('markers'), 'markers_solo');
  assert.equal(basePurposeOf('statistics_solo'), 'statistics');
  assert.equal(basePurposeOf('watch_progress'), 'watch_progress');
  assert.equal(isSoloPurpose('watch_progress_solo'), true);
  assert.equal(isSoloPurpose('watch_progress'), false);
});

test('Veraltete Fassung: nur bei erteilter Einwilligung mit anderer Version', () => {
  assert.equal(isOutdated(entry(true, { version: '2026-01-01' })), true);
  assert.equal(isOutdated(entry(true)), false);
  assert.equal(isOutdated(entry(false)), false);
  assert.equal(isOutdated(undefined), false);
});
