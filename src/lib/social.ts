/**
 * Freunde und Einladungen in Räume über die API der offiziellen Plattform.
 * Nur im Background verwenden.
 *
 * - Freunde sehen voneinander nur den Benutzernamen. Verwaltet werden sie auf app.synchrothek.de,
 *   hier gibt es nur die Liste, um jemanden in den eigenen Raum einzuladen.
 * - Offene Einladungen an mich werden abgefragt, solange man angemeldet ist (Alarm etwa jede Minute,
 *   beim Öffnen des Popups zusätzlich), nie öfter als alle 30 Sekunden.
 * - Automatische Abfragen melden Fehler nicht in der Oberfläche.
 */
import { ApiError, type Api, type Friend, type RoomInvite } from './api.ts';
import type { SocialStatus } from './messages';

const POLL_MIN_INTERVAL_MS = 30_000;
const FRIENDS_MAX_AGE_MS = 60_000;

export interface SocialDeps {
  api: Api;
  isSignedIn(): boolean;
  onChange(): void;
  /** Die API lehnt auch ein frisches Token ab: neu anmelden lassen. */
  onReauth(): void;
  /** Aktuelle offene Einladungen (für Badge und Benachrichtigungen). */
  onInvites(invites: RoomInvite[]): void;
}

export function createSocial(deps: SocialDeps) {
  const { api } = deps;

  let generation = 0;
  let invites: RoomInvite[] = [];
  let lastPoll = 0;
  let polling: Promise<void> | null = null;
  let friends: Friend[] | null = null;
  let friendsAt = 0;
  const invited = new Map<string, Set<string>>(); // Raumcode → eingeladene Konto-IDs
  let error: string | null = null;
  let busy = false;

  /** Abgelaufene Einladungen nicht mehr anzeigen. */
  const active = (list: RoomInvite[]) => list.filter((i) => Date.parse(i.expiresAt) > Date.now());

  function setInvites(next: RoomInvite[]) {
    invites = next;
    deps.onInvites(invites);
  }

  function reset() {
    generation++;
    lastPoll = 0;
    polling = null;
    friends = null;
    friendsAt = 0;
    invited.clear();
    error = null;
    busy = false;
    // Nur melden, wenn es etwas wegzuräumen gibt: Beim Start des Service Workers sollen
    // Benachrichtigungen noch gültiger Einladungen stehen bleiben
    if (invites.length) setInvites([]);
  }

  function handle(err: unknown, report: boolean) {
    if (!(err instanceof ApiError)) {
      console.warn('Synchrothek: API', err);
      if (report) error = 'Unerwarteter Fehler.';
      return;
    }
    switch (err.code) {
      case 'reauth':
        deps.onReauth();
        return;
      case 'signed_out':
      case 'banned': // Hinweis und Abmeldung kommen einmal aus dem Background
      case 'auth': // Anmeldung verloren: dazu gibt es genau einen Hinweis (auth.ts), keine weiteren
        return;
      default:
        if (report) error = err.message;
        else console.info(`Synchrothek: API ${err.code}: ${err.message}`);
    }
  }

  /** Offene Einladungen abfragen (höchstens alle `minIntervalMs`, nie öfter als alle 30 s). */
  function poll(minIntervalMs = POLL_MIN_INTERVAL_MS): Promise<void> {
    if (!deps.isSignedIn()) return Promise.resolve();
    if (polling) return polling;
    if (Date.now() - lastPoll < Math.max(minIntervalMs, POLL_MIN_INTERVAL_MS)) {
      const current = active(invites);
      if (current.length !== invites.length) {
        setInvites(current);
        deps.onChange();
      }
      return Promise.resolve();
    }
    const gen = generation;
    lastPoll = Date.now();
    polling = (async () => {
      try {
        const items = await api.listRoomInvites();
        if (gen === generation) setInvites(active(items));
      } catch (err) {
        if (gen === generation) handle(err, false);
      } finally {
        if (gen === generation) polling = null;
        deps.onChange();
      }
    })();
    return polling;
  }

  /** Einladung aus der Liste nehmen (vor dem Beitreten bzw. Ablehnen). Liefert sie, falls noch gültig. */
  function take(id: string): RoomInvite | null {
    const invite = active(invites).find((i) => i.id === id) ?? null;
    setInvites(active(invites).filter((i) => i.id !== id));
    deps.onChange();
    return invite;
  }

  /** Einladung auf der Plattform löschen (angenommen oder abgelehnt). Schon weg: auch gut. */
  async function remove(id: string) {
    try {
      await api.deleteRoomInvite(id);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'not_found')) handle(err, false);
    }
  }

  async function action(fn: () => Promise<void>) {
    const gen = generation;
    busy = true;
    error = null;
    deps.onChange();
    try {
      await fn();
    } catch (err) {
      if (gen === generation) handle(err, true);
    } finally {
      if (gen === generation) busy = false;
      deps.onChange();
    }
  }

  function loadFriends(force = false) {
    if (!deps.isSignedIn()) return Promise.resolve();
    if (!force && friends && Date.now() - friendsAt < FRIENDS_MAX_AGE_MS) return Promise.resolve();
    return action(async () => {
      const gen = generation;
      const list = await api.listFriends();
      if (gen !== generation) return;
      friends = list;
      friendsAt = Date.now();
    });
  }

  /** Bestätigten Freund in den Raum einladen. Erneutes Einladen ersetzt die Einladung (neue 15 Minuten). */
  function inviteFriend(friendId: string, roomCode: string, title: string | null) {
    return action(async () => {
      const gen = generation;
      try {
        await api.createRoomInvite(friendId, roomCode, title);
      } catch (err) {
        // Freundschaft inzwischen beendet: Liste still auffrischen, die Meldung bleibt stehen
        if (err instanceof ApiError && err.code === 'not_friends') {
          const list = await api.listFriends().catch(() => null);
          if (list && gen === generation) {
            friends = list;
            friendsAt = Date.now();
          }
        }
        throw err;
      }
      if (gen !== generation) return;
      const set = invited.get(roomCode) ?? new Set<string>();
      set.add(friendId);
      invited.set(roomCode, set);
    });
  }

  function status(roomCode: string | null, canInvite: boolean): SocialStatus {
    return {
      invites: deps.isSignedIn() ? active(invites) : [],
      canInvite,
      friends: deps.isSignedIn() ? friends : null,
      invited: roomCode ? [...(invited.get(roomCode) ?? [])] : [],
      error,
      busy,
    };
  }

  return {
    reset,
    poll,
    take,
    remove,
    loadFriends,
    inviteFriend,
    status,
    dismissError: () => {
      error = null;
    },
  };
}

export type Social = ReturnType<typeof createSocial>;
