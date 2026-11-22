/**
 * Tests für Freunde und Raum-Einladungen (src/lib/social.ts) mit nachgebildeter API.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, type Api, type RoomInvite } from '../src/lib/api.ts';
import { createSocial } from '../src/lib/social.ts';

const inFuture = (min: number) => new Date(Date.now() + min * 60_000).toISOString();
const invite = (id: string, expiresAt = inFuture(10)): RoomInvite => ({
  id,
  from: { id: 'a1', username: 'Anna_A' },
  roomCode: 'XY7K2M',
  title: 'Tatort',
  createdAt: '',
  expiresAt,
});

function setup(api: Partial<Api>, { signedIn = true } = {}) {
  const shown: RoomInvite[][] = [];
  let reauth = 0;
  let calls = 0;
  const wrapped = Object.fromEntries(
    Object.entries(api).map(([k, fn]) => [k, (...args: unknown[]) => (calls++, (fn as (...a: unknown[]) => unknown)(...args))]),
  ) as unknown as Api;
  const social = createSocial({
    api: wrapped,
    isSignedIn: () => signedIn,
    onChange: () => {},
    onReauth: () => reauth++,
    onInvites: (list) => shown.push(list),
  });
  return { social, shown, reauth: () => reauth, calls: () => calls };
}

test('Abfrage höchstens alle 30 s, abgelaufene Einladungen fallen weg', async () => {
  const { social, shown, calls } = setup({
    listRoomInvites: async () => [invite('i1'), invite('alt', new Date(Date.now() - 1000).toISOString())],
  });
  await social.poll();
  await social.poll(); // zu früh: keine zweite Anfrage
  assert.equal(calls(), 1);
  assert.deepEqual(shown.at(-1)?.map((i) => i.id), ['i1']);
  assert.deepEqual(social.status(null, false).invites.map((i) => i.id), ['i1']);
});

test('ohne Anmeldung keine Abfrage', async () => {
  const { social, calls } = setup({ listRoomInvites: async () => [invite('i1')] }, { signedIn: false });
  await social.poll();
  assert.equal(calls(), 0);
  assert.deepEqual(social.status(null, false).invites, []);
});

test('verlorene Anmeldung: kein Fehler in der Oberfläche (Hinweis kommt einmal aus auth.ts)', async () => {
  const { social } = setup({
    listRoomInvites: async () => {
      throw new ApiError('auth', 'Du bist nicht mehr angemeldet.');
    },
    listFriends: async () => {
      throw new ApiError('auth', 'Du bist nicht mehr angemeldet.');
    },
  });
  await social.poll();
  await social.loadFriends(true);
  assert.equal(social.status(null, true).error, null);
});

test('401 auch nach Erneuerung meldet „neu anmelden“', async () => {
  const { social, reauth } = setup({
    listRoomInvites: async () => {
      throw new ApiError('reauth', 'x');
    },
  });
  await social.poll();
  assert.equal(reauth(), 1);
});

test('Annehmen nimmt die Einladung aus der Liste, Löschen verträgt „schon weg“', async () => {
  const { social, shown } = setup({
    listRoomInvites: async () => [invite('i1'), invite('i2')],
    deleteRoomInvite: async () => {
      throw new ApiError('not_found', 'x');
    },
  });
  await social.poll();
  const taken = social.take('i1');
  assert.equal(taken?.roomCode, 'XY7K2M');
  assert.deepEqual(shown.at(-1)?.map((i) => i.id), ['i2']);
  assert.equal(social.take('i1'), null); // nur einmal
  await social.remove('i1');
  assert.equal(social.status(null, false).error, null);
});

test('Einladen merkt sich den Freund je Raum; nicht befreundet zeigt die Meldung der Plattform', async () => {
  let fail = false;
  const { social } = setup({
    createRoomInvite: async () => {
      if (fail) throw new ApiError('not_friends', 'Ihr seid nicht befreundet.');
    },
    listFriends: async () => [],
  });
  await social.inviteFriend('f1', 'XY7K2M', null);
  assert.deepEqual(social.status('XY7K2M', true).invited, ['f1']);
  assert.deepEqual(social.status('ABCDEF', true).invited, []);
  fail = true;
  await social.inviteFriend('f2', 'XY7K2M', null);
  assert.equal(social.status('XY7K2M', true).error, 'Ihr seid nicht befreundet.');
});

test('Abmelden vergisst alles', async () => {
  const { social, shown } = setup({ listRoomInvites: async () => [invite('i1')] });
  await social.poll();
  social.reset();
  assert.deepEqual(shown.at(-1), []);
  assert.deepEqual(social.status(null, false).invites, []);
});
