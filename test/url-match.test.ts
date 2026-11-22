/**
 * Tests für die Host-Prüfung (src/lib/url-match.ts) und die Erkennung des Formatnamens (src/lib/series.ts).
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seriesFromJsonLd } from '../src/lib/series.ts';
import { isAppUrl, isMediathekUrl, matchesAny } from '../src/lib/url-match.ts';

test('Mediathek-Adressen: nur https und echte Hosts der unterstützten Mediatheken', () => {
  assert.equal(isMediathekUrl('https://www.zdf.de/serien/x-100.html'), true);
  assert.equal(isMediathekUrl('https://zdf.de/'), true);
  assert.equal(isMediathekUrl('https://www.ardmediathek.de/video/x/y'), true);
  assert.equal(isMediathekUrl('https://WWW.ZDF.DE/x'), true); // Host wird klein geschrieben
  assert.equal(isMediathekUrl('http://www.zdf.de/x'), false);
  assert.equal(isMediathekUrl('https://zdf.de.evil.example/x'), false);
  assert.equal(isMediathekUrl('https://evilzdf.de/x'), false);
  assert.equal(isMediathekUrl('https://evil.example/?u=https://www.zdf.de/'), false);
  assert.equal(isMediathekUrl('https://user:pw@www.zdf.de/x'), false);
  assert.equal(isMediathekUrl('https://www.zdf.de:8443/x'), false);
  assert.equal(isMediathekUrl('javascript:alert(1)'), false);
  assert.equal(isMediathekUrl('chrome://extensions'), false);
  assert.equal(isMediathekUrl(null), false);
  assert.equal(isMediathekUrl('kein url'), false);
});

test('Plattform-Adresse nur exakt app.synchrothek.de', () => {
  assert.equal(isAppUrl('https://app.synchrothek.de/hilfe'), true);
  assert.equal(isAppUrl('https://x.app.synchrothek.de/'), false);
  assert.equal(isAppUrl('https://synchrothek.de/'), false);
});

test('Patterns ohne Platzhalter passen nur auf den Host selbst', () => {
  assert.equal(matchesAny('https://a.example/x', ['https://a.example/*']), true);
  assert.equal(matchesAny('https://b.a.example/x', ['https://a.example/*']), false);
  assert.equal(matchesAny('https://a.example/x', ['kaputt']), false);
});

test('Formatname aus JSON-LD (partOfSeries, @graph, Staffel), sonst null', () => {
  const ld = (o: unknown) => JSON.stringify(o);
  assert.equal(seriesFromJsonLd([ld({ '@type': 'TVEpisode', name: 'Folge 1', partOfSeries: { '@type': 'TVSeries', name: ' Beispiel ' } })]), 'Beispiel');
  assert.equal(seriesFromJsonLd([ld({ '@graph': [{ '@type': 'WebPage' }, { '@type': 'Episode', partOfSeries: { name: 'Reihe' } }] })]), 'Reihe');
  assert.equal(seriesFromJsonLd([ld({ partOfSeason: { name: 'Staffel 2', partOfSeries: { name: 'Serie' } } })]), 'Serie');
  assert.equal(seriesFromJsonLd([ld({ '@type': 'Movie', name: 'Film' })]), null);
  assert.equal(seriesFromJsonLd(['{kaputt', ld({ partOfSeries: [{ name: 'Erste' }] })]), 'Erste');
  assert.equal([...(seriesFromJsonLd([ld({ partOfSeries: { name: 'x'.repeat(400) } })]) ?? '')].length, 300);
  assert.equal(seriesFromJsonLd([]), null);
});
