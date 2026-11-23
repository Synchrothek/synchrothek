/*
 * Synchrothek – Popup (Design „Popup v3“)
 * Zeigt den Zustand aus dem Hintergrund an und schickt Befehle zurück. Eigener Zustand nur für die
 * Oberfläche (Reiter, Unteransichten, Bestätigungen, Entwürfe in den Einstellungen).
 */
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import { browser } from 'wxt/browser';
import { PURPOSES, type BasePurpose, type Friend, type Marker, type ProgressItem, type Purpose, type RoomInvite } from '../../lib/api';
import { API_HOST_MATCH } from '../../lib/config';
import type { ConsentView, FeaturesStatus, PopupCommand, PopupStatus, SocialStatus, ToPopup } from '../../lib/messages';
import type { MemberInfo } from '../../lib/protocol';
import {
  browserLanguages,
  formatDate,
  formatTime,
  LANG_STORAGE_KEY,
  resolveLanguage,
  setLanguage,
  t,
  type Lang,
  type LangSetting,
  type MessageKey,
} from '../../lib/i18n';
import { appLink, isSitePage, siteLink } from '../../lib/i18n/links';
import { formatDuration, formatPosition } from '../../lib/time';
import { basePurposeOf, isSoloPurpose, soloPurposeOf } from '../../lib/watch-context';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const baseLabel = (p: BasePurpose) => t(`purpose.${p}`);
const purposeLabel = (p: Purpose) =>
  isSoloPurpose(p) ? t('purpose.soloShort', { label: baseLabel(basePurposeOf(p)) }) : baseLabel(p as BasePurpose);
const LIB_TABS: { key: LibTab; purpose: BasePurpose }[] = [
  { key: 'wp', purpose: 'watch_progress' },
  { key: 'mk', purpose: 'markers' },
  { key: 'st', purpose: 'statistics' },
];
const SEEK_STEP = 10;
const ARM_MS = 3000;
const PEEK_MS = 1000;
const MAX_STEP_CAP = 50; // ohne Obergrenze des Servers: 1 … 50, darüber „unbegrenzt“
const SETTINGS_DEBOUNCE_MS = 400;
const PROGRESS_RELOAD_MS = 10_000;

type Tab = 'room' | 'library';
type RoomSub = 'members' | 'friends' | 'roomSettings' | null;
type SettingsSub = 'server' | 'consents' | null;
type LibTab = 'wp' | 'mk' | 'st';

/** Zustand der Oberfläche (nicht der Daten). */
const ui = {
  tab: 'room' as Tab,
  roomSub: null as RoomSub,
  settings: false,
  settingsSub: null as SettingsSub,
  libTab: 'wp' as LibTab,
  dialog: null as { purpose: Purpose } | null,
  armed: null as string | null,
  copied: false,
  draftName: null as string | null,
  draftServer: null as string | null,
  maxDraft: null as number | null,
  progressRequestedAt: 0,
};

let send: (cmd: PopupCommand) => void = () => {};
let lastStatus: PopupStatus | null = null;
let armTimer: number | undefined;
let copyTimer: number | undefined;
let maxTimer: number | undefined;

/** Listen nur neu aufbauen, wenn sich der Inhalt geändert hat. */
const rendered = new Map<string, string>();
function renderList(id: string, key: unknown, build: () => HTMLElement[]) {
  const k = JSON.stringify(key);
  if (rendered.get(id) === k) return;
  rendered.set(id, k);
  $(id).replaceChildren(...build());
}

function rerender() {
  if (lastStatus) render(lastStatus);
}

// ---------------------------------------------------------------------------
// Sprache: statische Texte (data-i18n*) und Links füllen; dynamische Texte entstehen beim Rendern
// ---------------------------------------------------------------------------

let appliedLang: Lang | null = null;

const I18N_ATTRIBUTES = [
  ['data-i18n-title', 'title'],
  ['data-i18n-aria-label', 'aria-label'],
  ['data-i18n-placeholder', 'placeholder'],
] as const;

function applyLanguage(lang: Lang) {
  setLanguage(lang);
  if (appliedLang === lang) return;
  appliedLang = lang;
  document.documentElement.lang = lang;
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t(node.dataset.i18n as MessageKey);
  for (const [data, attr] of I18N_ATTRIBUTES) {
    for (const node of document.querySelectorAll<HTMLElement>(`[${data}]`)) node.setAttribute(attr, t(node.getAttribute(data) as MessageKey));
  }
  // Plattform mit ?lang=, Website mit den Seiten der Sprache
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-app-link]')) a.href = appLink(a.dataset.appLink!);
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-site-link]')) {
    const [page, hash] = a.dataset.siteLink!.split('#');
    if (isSitePage(page)) a.href = siteLink(page, hash);
  }
  rendered.clear(); // Listen in der neuen Sprache neu aufbauen
}

/** Sprache vor der ersten Antwort des Hintergrunds (gleiche Regel wie dort), damit nichts leer bleibt. */
async function guessLanguage(): Promise<Lang> {
  let setting: unknown;
  try {
    setting = (await browser.storage.local.get(LANG_STORAGE_KEY))[LANG_STORAGE_KEY];
  } catch {}
  return resolveLanguage(setting, browserLanguages(), browser.i18n?.getUILanguage?.());
}

// ---------------------------------------------------------------------------
// Profilbilder: kommen als data:-URL aus dem Hintergrund (dort mit Token geladen und
// zwischengespeichert), hier als Blob-URL angezeigt. Ohne Bild bleibt die Initiale.
// ---------------------------------------------------------------------------

const avatarImages = new Map<string, string | null>(); // avatarUrl → Blob-URL, oder null = kein Bild
const avatarRequested = new Set<string>();
let avatarBatch: string[] = [];
let avatarObserver: IntersectionObserver | null = null;

/** Je Adresse nur einmal anfordern; Anfragen eines Durchlaufs gesammelt senden. */
function requestAvatars(urls: string[]) {
  const fresh = urls.filter((url) => !avatarRequested.has(url));
  if (!fresh.length) return;
  for (const url of fresh) avatarRequested.add(url);
  if (!avatarBatch.length) {
    queueMicrotask(() => {
      send({ cmd: 'avatars', urls: avatarBatch });
      avatarBatch = [];
    });
  }
  avatarBatch.push(...fresh);
}

async function onAvatar(url: string, dataUrl: string | null) {
  if (avatarImages.get(url)) return;
  let blobUrl: string | null = null;
  if (dataUrl?.startsWith('data:image/')) {
    try {
      blobUrl = URL.createObjectURL(await (await fetch(dataUrl)).blob());
    } catch {
      blobUrl = null;
    }
  }
  avatarImages.set(url, blobUrl);
  rendered.delete('friend-items');
  rerender();
}

/**
 * Profilbild oder Initiale in einen Avatar-Platzhalter setzen. `lazy`: erst anfordern, wenn er
 * sichtbar wird (lange Freundeslisten, Rate-Limit der API).
 */
function fillAvatar(span: HTMLElement, name: string, url: string | null, { lazy = false } = {}) {
  const img = url ? avatarImages.get(url) : null;
  const key = `${url ?? ''}|${img ?? ''}|${name}`;
  if (span.dataset.key !== key) {
    span.dataset.key = key;
    span.classList.toggle('has-img', !!img);
    if (img) {
      const image = el('img', 'avatar-img');
      image.src = img;
      image.alt = '';
      // Bild kaputt: wie „kein Bild“ behandeln
      image.addEventListener('error', () => {
        if (url) avatarImages.set(url, null);
        rendered.delete('friend-items');
        rerender();
      });
      span.replaceChildren(image);
    } else {
      span.textContent = initial(name);
    }
  }
  if (!url || avatarImages.has(url) || avatarRequested.has(url)) return;
  if (lazy && avatarObserver) {
    span.dataset.avatarUrl = url;
    avatarObserver.observe(span);
  } else requestAvatars([url]);
}

// ---------------------------------------------------------------------------
// Kleine Bausteine (fremde Inhalte immer nur als Text)
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

const initial = (name: string) => [...name.trim()][0]?.toUpperCase() ?? '?';

/** Zweistufige Bestätigung: erster Klick färbt den Knopf, zweiter innerhalb von 3 s führt aus. */
function arm(key: string, action: () => void) {
  clearTimeout(armTimer);
  if (ui.armed === key) {
    ui.armed = null;
    action();
  } else {
    ui.armed = key;
    armTimer = window.setTimeout(() => {
      ui.armed = null;
      rerender();
    }, ARM_MS);
  }
  rerender();
}

function armButton(key: string, label: string, confirmLabel: string, className: string, action: () => void, title?: string) {
  const armed = ui.armed === key;
  const b = button(armed ? confirmLabel : label, `${className}${armed ? ' armed' : ''}`, () => arm(key, action), title);
  return b;
}

function minutesLeft(iso: string): number {
  return Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 60_000));
}

/** Lesbare Notlösung, wenn der Titel der Sendung (noch) unbekannt ist. */
function urlLabel(url: string): string {
  try {
    return t('show.onHost', { host: new URL(url).hostname.replace(/^www\./, '') });
  } catch {
    return t('show.generic');
  }
}

// ---------------------------------------------------------------------------
// Kopf, Reiter, Hinweis
// ---------------------------------------------------------------------------

function renderChrome(s: PopupStatus) {
  const connected = s.conn === 'open' && (s.inRoom || s.pending);
  const conn = s.conn === 'connecting' ? 'connecting' : connected ? 'open' : 'idle';
  $('conn-dot').className = `dot ${conn}`;
  const connLabel = t(`conn.${conn}`);
  $('conn-text').textContent = connLabel;
  $('conn').title = `${connLabel} – ${s.serverUrl}`;

  const account = s.account;
  $('login-top').hidden = account.state !== 'signedOut';
  $('login-top-pending').hidden = account.state !== 'signingIn';
  if (account.state === 'signingIn') {
    // Anmeldung im Tab (Standard) bzw. im Fenster von launchWebAuthFlow (Rückfall)
    const key = account.where === 'window' ? 'account.signingInWindow' : 'account.signingIn';
    for (const node of document.querySelectorAll<HTMLElement>('.signing-in-text')) node.textContent = t(key);
    $('login-top-pending').title = t(key);
  }
  $('avatar').hidden = account.state !== 'signedIn';
  $('gear').hidden = account.state === 'signedIn';
  if (account.state === 'signedIn') fillAvatar($('avatar-initial'), s.profile?.username ?? account.name ?? s.name, s.profile?.avatarUrl ?? null);

  $('tabs').hidden = ui.settings;
  $('settings-rule').hidden = !ui.settings;
  $('tab-room-label').textContent = t(s.inRoom ? 'tabs.room' : 'tabs.watchTogether');
  const invites = s.social.invites.length;
  $('tab-badge').hidden = invites === 0;
  $('tab-badge').textContent = String(invites);
  $('tab-room').setAttribute('aria-selected', String(ui.tab === 'room'));
  $('tab-library').setAttribute('aria-selected', String(ui.tab === 'library'));

  // Plattform: Update-Aufforderung und Wartungshinweis (nur als Text)
  const update = s.platform.update;
  $('update-banner').hidden = !update;
  if (update) $('update-text').textContent = t('update.text', { current: update.current, minimum: update.minimum, how: updateHow(s) });
  // Wartungshinweis: Freitext der Plattform, unverändert
  $('service-notice').hidden = !s.platform.notice;
  $('service-notice-text').textContent = s.platform.notice ?? '';

  $('notice').hidden = !s.notice;
  $('notice').className = `notice ${s.notice?.kind ?? ''}`;
  $('notice-text').textContent = s.notice?.text ?? '';
  $('notice-retry').hidden = !s.notice?.retry;
}

/** Wie man aktualisiert: Store-Installationen aktualisieren sich selbst, selbst geladene nicht. */
function updateHow(s: PopupStatus): string {
  if (import.meta.env.FIREFOX) {
    return t(s.installType === 'development' ? 'update.firefoxDev' : 'update.firefox');
  }
  return t(s.installType === 'development' ? 'update.chromeDev' : 'update.chrome');
}

// ---------------------------------------------------------------------------
// Einladungen
// ---------------------------------------------------------------------------

function renderInvites(social: SocialStatus, s: PopupStatus) {
  const visible = !ui.settings && ui.tab === 'room' && !ui.roomSub && !s.pending && social.invites.length > 0;
  $('invites').hidden = !visible;
  if (!visible) return;
  const minutes = social.invites.map((i) => minutesLeft(i.expiresAt));
  renderList('invite-items', [social.invites, s.inRoom, minutes], () =>
    social.invites.map((invite: RoomInvite, i) => {
      const card = el('div', 'invite');
      const main = el('div', 'invite-main');
      const text = el('div', 'invite-text');
      text.append(el('strong', '', invite.from.username), ` ${t(invite.title ? 'invites.withTitle' : 'invites.noTitle')}`);
      if (invite.title) text.append(' ', el('em', '', invite.title));
      const body = el('div', 'grow stack-2');
      body.append(text, el('div', 'hint', t('invites.validFor', { minutes: minutes[i]! })));
      main.append(el('span', 'avatar surface', initial(invite.from.username)), body);
      const actions = el('div', 'invite-actions');
      const accept = button(t('lobby.join'), 'accept', () => send({ cmd: 'acceptInvite', id: invite.id }));
      if (s.inRoom) accept.title = t('invites.leavesRoom');
      actions.append(accept, button(t('invites.decline'), 'decline', () => send({ cmd: 'declineInvite', id: invite.id })));
      card.append(main, actions);
      if (s.inRoom) card.append(el('div', 'invite-leave', t('invites.leavesRoom')));
      return card;
    }),
  );
}

// ---------------------------------------------------------------------------
// Gemeinsam schauen: Lobby, Verbinden, Raum
// ---------------------------------------------------------------------------

function renderLobby(s: PopupStatus, visible: boolean) {
  $('lobby').hidden = !visible;
  $('pending').hidden = !(ui.tab === 'room' && !ui.settings && s.pending);
  $('pending-sub').textContent = s.code ? t('pending.searching', { code: s.code }) : t('pending.creating');
  if (!visible) return;
  $('create-hint').hidden = s.tab.hasVideo;
  $('join-hint').hidden = !s.autoFollow;
  $('lobby-account-out').hidden = s.account.state !== 'signedOut';
  $('lobby-account-pending').hidden = s.account.state !== 'signingIn';
}

/** Zustand der Sendung im Raum-Tab: Text und Farbe des Punkts. */
function contentStatus(s: PopupStatus): [string, string] {
  if (!s.tab.isBound) return [t('room.status.otherTab'), ''];
  if (!s.room?.url) return [t('room.status.none'), ''];
  if (s.tab.onRoomContent) return [t('room.status.connected'), 'ok'];
  if (s.tab.hasVideo) return [t('room.status.other'), 'danger'];
  return s.autoFollow ? [t('room.status.opening'), 'accent'] : [t('room.status.notOpen'), ''];
}

/**
 * Was der Raum dank Konto mehr hat als der Server-Standard. Nur aus den Werten des Servers
 * (welcome.server.limits = Grenzen ohne Konto, room.memberLimit/closesAt = Grenzen dieses Raums).
 */
function accountLimitsHint(s: PopupStatus): string | null {
  const defaults = s.server?.limits;
  const room = s.room;
  if (!defaults || !room) return null;
  const parts: string[] = [];
  if (defaults.maxRoomDurationMinutes > 0 && room.closesAt === null) parts.push(t('room.limits.noTimeLimit'));
  const more = defaults.maxRoomMembers > 0 && (room.memberLimit === 0 || room.memberLimit > defaults.maxRoomMembers);
  if (more) parts.push(room.memberLimit === 0 ? t('room.limits.unlimitedMembers') : t('room.limits.upTo', { count: room.memberLimit }));
  return parts.length ? t('room.limits.hint', { parts: parts.join(', ') }) : null;
}

function sortedMembers(s: PopupStatus): MemberInfo[] {
  const room = s.room!;
  return [...room.members].sort((a, b) => Number(b.id === room.hostId) - Number(a.id === room.hostId));
}

function memberCount(s: PopupStatus): string {
  const max = s.room!.settings.maxMembers;
  return `${s.room!.members.length}${max > 0 ? ` / ${max}` : ''}`;
}

function renderRoom(s: PopupStatus, visible: boolean) {
  $('room').hidden = !visible;
  if (!visible || !s.room) return;
  const room = s.room;

  $('host-badge').hidden = !s.isHost;
  $('closes').hidden = room.closesAt === null;
  if (room.closesAt !== null) $('closes').textContent = t('room.closesAt', { time: formatTime(room.closesAt) });
  $('code-text').textContent = s.code ?? '';
  $('copy-label').textContent = t(ui.copied ? 'room.copied' : 'room.copy');
  const accountHint = room.createdWithAccount ? accountLimitsHint(s) : null;
  $('account-room').hidden = !accountHint;
  $('account-room').textContent = accountHint ?? '';

  // Sendung
  const title = room.url ? (room.title ?? urlLabel(room.url)) : t('room.noShow');
  $('video-title').textContent = title;
  $('video-title').classList.toggle('empty', !room.url);
  const [statusText, statusDot] = contentStatus(s);
  $('video-status').textContent = statusText;
  $('status-dot').className = `dot sm ${statusDot}`;

  const onRoom = s.tab.isBound && s.tab.onRoomContent;
  $('playback').hidden = !onRoom;
  if (onRoom) {
    const pos = s.tab.position;
    const dur = s.tab.duration;
    $('playback-label').textContent = `${t(room.playing ? 'room.playing' : 'room.paused')}${pos !== null ? ` · ${formatPosition(pos)}` : ''}`;
    $('playback-duration').textContent = dur ? formatPosition(dur) : '';
    $('playback-bar').style.width = pos !== null && dur ? `${Math.min(100, (pos / dur) * 100)}%` : '0';
  }
  $('controls').hidden = !onRoom || !s.canControl;
  $('icon-pause').hidden = !room.playing;
  $('icon-play').hidden = room.playing;
  $('sync').hidden = !onRoom || !s.isHost;
  $('host-only').hidden = !onRoom || s.canControl;

  const share = s.tab.isBound && s.tab.hasVideo && !s.tab.onRoomContent && s.canControl;
  $('share-content').hidden = !share;
  $('open-url').hidden = !s.tab.isBound || !room.url || s.tab.onRoomContent;
  $('open-url').className = share ? 'btn ghost md-plus strong-500' : 'btn primary md-plus';
  $('bind-tab').hidden = s.tab.isBound;

  // Teilnehmer, Freunde, Raumeinstellungen
  const members = sortedMembers(s);
  $('member-names').textContent = members.map((m) => m.name).join(', ');
  $('member-count').textContent = memberCount(s);
  renderList('avatar-stack', members.slice(0, 4).map((m) => [m.name, m.connected]), () =>
    members.slice(0, 4).map((m) => el('span', m.connected ? '' : 'offline', initial(m.name))),
  );
  $('go-friends').hidden = !s.social.canInvite;
  $('friends-summary').textContent = s.social.invited.length
    ? t('friends.invitedCount', { count: s.social.invited.length })
    : t('friends.fromList');
  $('go-room-settings').hidden = !s.isHost;
  const max = room.settings.maxMembers;
  $('rs-summary').textContent = t('roomSettings.summary', {
    max: max > 0 ? max : '∞',
    mode: t(room.settings.controlMode === 'all' ? 'roomSettings.summaryAll' : 'roomSettings.summaryHost'),
  });
  // Trennlinien nur zwischen sichtbaren Zeilen
  const rows = ['go-members', 'go-friends', 'go-room-settings'].map((id) => $(id)).filter((r) => !r.hidden);
  rows.forEach((r, i) => r.classList.toggle('divided', i > 0));
}

function renderMembers(s: PopupStatus, visible: boolean) {
  $('sub-members').hidden = !visible;
  if (!visible || !s.room) return;
  const room = s.room;
  $('sub-member-count').textContent = memberCount(s);
  $('members-invite').hidden = !s.social.canInvite;
  const members = sortedMembers(s);
  renderList('members', [members, room.hostId, s.me, s.isHost, ui.armed], () =>
    members.map((m) => {
      const row = el('div', 'member');
      const avatar = el('span', `avatar${m.connected ? '' : ' offline'}`, initial(m.name));
      const tags = [m.id === s.me && t('members.you'), m.id === room.hostId && t('room.host'), !m.connected && t('members.disconnected')]
        .filter(Boolean)
        .join(' · ');
      const name = el('span', `name grow ellipsis${m.connected ? '' : ' offline'}`, m.name); // fremder Name: nur Text
      name.title = m.name;
      if (tags) name.append(' ', el('span', 'tags', tags));
      row.append(avatar, name);
      if (s.isHost && m.id !== s.me) {
        const actions = el('div', 'member-actions');
        if (m.connected) {
          actions.append(
            armButton(`host:${m.id}`, t('room.host'), t('members.makeHostConfirm'), 'act', () => send({ cmd: 'transferHost', memberId: m.id }), t('members.makeHost')),
          );
        }
        actions.append(
          armButton(`kick:${m.id}`, t('members.kick'), t('common.sure'), 'act', () => send({ cmd: 'kick', memberId: m.id, ban: false })),
          armButton(`ban:${m.id}`, t('members.ban'), t('common.sure'), 'act', () => send({ cmd: 'kick', memberId: m.id, ban: true })),
        );
        row.append(actions);
      }
      return row;
    }),
  );
}

function renderFriends(s: PopupStatus, visible: boolean) {
  $('sub-friends').hidden = !visible;
  if (!visible) return;
  const social = s.social;
  $('social-error').hidden = !social.error;
  $('social-error').textContent = social.error ?? '';
  const friends = social.friends;
  $('friends-loading').hidden = friends !== null;
  $('friends-empty').hidden = !friends || friends.length > 0;
  renderList('friend-items', [friends, social.invited, social.busy], () =>
    (friends ?? []).map((friend: Friend) => {
      const row = el('div', 'friend');
      const done = social.invited.includes(friend.id);
      const invite = button(t(done ? 'friends.inviteAgain' : 'friends.invite'), 'btn xs', () => send({ cmd: 'inviteFriend', friendId: friend.id }));
      invite.disabled = social.busy;
      const name = el('span', 'grow ellipsis', friend.username);
      name.title = friend.username;
      const avatar = el('span', 'avatar');
      fillAvatar(avatar, friend.username, friend.avatarUrl, { lazy: true });
      row.append(avatar, name);
      if (done) row.append(el('span', 'hint', t('friends.invited')));
      row.append(invite);
      return row;
    }),
  );
}

/** Werte des Schrittzählers für „Max. Teilnehmer“ (0 = unbegrenzt, nur ohne Obergrenze des Servers). */
function maxStep(s: PopupStatus, current: number, delta: 1 | -1): number {
  const room = s.room!;
  const min = Math.max(1, room.members.length);
  if (room.memberLimit > 0) return Math.min(room.memberLimit, Math.max(min, (current || room.memberLimit) + delta));
  if (current === 0) return delta < 0 ? MAX_STEP_CAP : 0;
  const next = current + delta;
  if (next > MAX_STEP_CAP) return 0;
  return Math.max(min, next);
}

function renderRoomSettings(s: PopupStatus, visible: boolean) {
  $('sub-room-settings').hidden = !visible;
  if (!visible || !s.room) return;
  const settings = s.room.settings;
  if (ui.maxDraft !== null && ui.maxDraft === settings.maxMembers) ui.maxDraft = null;
  const current = ui.maxDraft ?? settings.maxMembers;
  $('max-value').textContent = current > 0 ? String(current) : '∞';
  $('max-value').title = current > 0 ? '' : t('roomSettings.unlimited');
  $<HTMLButtonElement>('max-dec').disabled = maxStep(s, current, -1) === current;
  $<HTMLButtonElement>('max-inc').disabled = maxStep(s, current, 1) === current;
  $('mode-all').setAttribute('aria-pressed', String(settings.controlMode === 'all'));
  $('mode-host').setAttribute('aria-pressed', String(settings.controlMode === 'host'));
}

function stepMax(delta: 1 | -1) {
  const s = lastStatus;
  if (!s?.room || !s.isHost) return;
  const current = ui.maxDraft ?? s.room.settings.maxMembers;
  ui.maxDraft = maxStep(s, current, delta);
  rerender();
  // Mehrere Klicks zusammenfassen
  clearTimeout(maxTimer);
  maxTimer = window.setTimeout(() => {
    if (ui.maxDraft !== null) send({ cmd: 'updateSettings', maxMembers: ui.maxDraft });
  }, SETTINGS_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Meine Mediathek
// ---------------------------------------------------------------------------

function renderLibrary(s: PopupStatus, visible: boolean) {
  $('library').hidden = !visible;
  if (!visible) return;
  const f = s.features;
  $('lib-signed-out').hidden = f.state !== 'signedOut';
  $('lib-login').hidden = s.account.state !== 'signedOut';
  $('lib-login-pending').hidden = s.account.state !== 'signingIn';
  $('lib-permission').hidden = f.state !== 'noPermission';
  $('lib-reauth').hidden = f.state !== 'reauth';
  $('lib-loading').hidden = f.state !== 'loading';
  $('lib-unavailable').hidden = f.state !== 'error';
  $('lib-unavailable-detail').hidden = !f.error;
  $('lib-unavailable-detail').textContent = f.error ?? '';
  $('lib-ready').hidden = f.state !== 'ready';
  if (f.state !== 'ready' || !f.consent) return;

  // Nur Funktionen, die die Plattform kennt
  const tabs = LIB_TABS.filter((tab) => f.consent?.[tab.purpose]);
  if (!tabs.some((tab) => tab.key === ui.libTab) && tabs[0]) ui.libTab = tabs[0].key;
  renderList('lib-tabs', [tabs.map((tab) => tab.key), ui.libTab], () =>
    tabs.map((tab) => {
      const b = button(baseLabel(tab.purpose), '', () => {
        ui.libTab = tab.key;
        rerender();
      });
      b.setAttribute('aria-pressed', String(ui.libTab === tab.key));
      return b;
    }),
  );
  $('features-error').hidden = !f.error || !!ui.dialog;
  $('features-error').textContent = f.error ?? '';

  // Einwilligung in älterer Fassung erteilt: neue Fassung anbieten (gilt bis dahin weiter)
  const outdated = outdatedPurposes(f);
  $('lib-outdated').hidden = outdated.length === 0;
  $('lib-outdated-text').textContent = outdated.length
    ? t('library.outdated', { purposes: outdated.map(purposeLabel).join(', ') })
    : '';

  renderProgressPane(f, ui.libTab === 'wp');
  renderMarkerPane(s, ui.libTab === 'mk');
  renderStatsPane(f, ui.libTab === 'st');
}

function outdatedPurposes(f: FeaturesStatus): Purpose[] {
  return f.consent ? PURPOSES.filter((p) => f.consent?.[p]?.outdated) : [];
}

const SOLO_BOX: Record<BasePurpose, string> = { watch_progress: 'wp-solo', markers: 'mk-solo', statistics: 'st-solo' };

/**
 * Schalter „Auch beim alleine Schauen“ (Standard aus). Einschalten öffnet den eigenen Einwilligungstext
 * der Plattform, Ausschalten widerruft (zweistufig, löscht die Allein-Daten).
 */
function renderSoloBox(f: FeaturesStatus, base: BasePurpose) {
  const id = SOLO_BOX[base];
  const solo = soloPurposeOf(base);
  const c = f.consent?.[solo];
  const visible = !!f.consent?.[base]?.granted && !!c;
  $(id).hidden = !visible;
  if (!visible || !c) return;
  const armKey = `solo:${base}`;
  renderList(id, [c.granted, ui.armed, f.busy], () => {
    const row = button('', 'switch-row', () => {
      if (c.granted) arm(armKey, () => send({ cmd: 'revokeConsent', purpose: solo }));
      else openConsent(solo);
    });
    row.setAttribute('role', 'switch');
    row.setAttribute('aria-checked', String(c.granted));
    row.disabled = f.busy;
    const text = el('span', 'nav-text grow');
    const hint = ui.armed === armKey ? t('solo.turnOffConfirm') : t(`solo.hint.${base}`);
    text.append(el('span', 'strong-500', t('solo.label')), el('span', 'hint', hint));
    const sw = el('span', 'switch');
    sw.append(el('span'));
    row.append(text, sw);
    const items: HTMLElement[] = [row];
    if (c.granted) {
      items.push(
        armButton(`soloData:${base}`, t('solo.deleteData'), t('solo.deleteDataConfirm'), 'text-link small', () =>
          send({ cmd: 'deleteSoloData', purpose: base }),
        ),
      );
    }
    return items;
  });
}

const contextTag = (context: 'room' | 'solo') => (context === 'solo' ? el('span', 'ctx-tag', t('context.solo')) : null);

function renderProgressPane(f: FeaturesStatus, visible: boolean) {
  $('lib-wp').hidden = !visible;
  if (!visible) return;
  const on = !!f.consent?.watch_progress?.granted;
  $('progress-enable').hidden = on;
  $('progress-off').hidden = on;
  $('progress-on').hidden = !on;
  renderSoloBox(f, 'watch_progress');
  if (!on) return;
  const items = f.progressList;
  // Liste laden, sobald sie sichtbar ist (nicht öfter als alle 10 s)
  if (!items && !f.busy && Date.now() - ui.progressRequestedAt > PROGRESS_RELOAD_MS) {
    ui.progressRequestedAt = Date.now();
    send({ cmd: 'loadProgressList' });
  }
  $('progress-loading').hidden = items !== null;
  $('progress-empty').hidden = !items || items.length > 0;
  renderList('progress-items', [items, ui.armed], () =>
    (items ?? []).map((p: ProgressItem) => {
      const row = el('div', 'progress-item');
      const open = button('', 'progress-open', () => send({ cmd: 'openShow', url: p.url }), p.title);
      const meta = el('span', 'progress-meta');
      const bar = el('span', 'bar thin');
      const fill = el('span');
      fill.style.width = p.duration ? `${Math.min(100, (p.position / p.duration) * 100)}%` : '0';
      bar.append(fill);
      const time = p.duration ? `${formatPosition(p.position)} / ${formatPosition(p.duration)}` : formatPosition(p.position);
      meta.append(bar, el('span', 'mono', time));
      const tag = contextTag(p.context);
      if (tag) meta.append(tag);
      open.append(el('span', 'ellipsis', p.title), meta);
      row.append(
        open,
        armButton(`p:${p.context}:${p.url}`, '×', t('common.deleteConfirm'), 'del', () => send({ cmd: 'deleteProgress', url: p.url, context: p.context }), t('common.remove')),
      );
      return row;
    }),
  );
}

function renderMarkerPane(s: PopupStatus, visible: boolean) {
  $('lib-mk').hidden = !visible;
  if (!visible) return;
  const f = s.features;
  const on = !!f.consent?.markers?.granted;
  $('markers-enable').hidden = on;
  $('markers-off').hidden = on;
  $('markers-on').hidden = !on;
  $('markers-context').hidden = !on || !f.show || !s.tab.title;
  $('markers-context').textContent = s.tab.title ? `${s.tab.title} · ${t(f.context === 'solo' ? 'context.solo' : 'context.room')}` : '';
  $('markers-context').title = s.tab.title ?? '';
  renderSoloBox(f, 'markers');
  if (!on) return;
  // Allein ohne Zusatz-Einwilligung: keine Marker setzen (es würde nichts gespeichert)
  const canAdd = f.context === 'room' || !!f.consent?.markers_solo?.granted;
  $('markers-solo-hint').hidden = !f.show || canAdd;
  $('marker-form').hidden = !f.show || !canAdd;
  $('markers-novideo').hidden = !!f.show;
  $<HTMLButtonElement>('marker-add').disabled = f.busy;
  $('marker-time').textContent = f.show && s.tab.position !== null ? formatPosition(s.tab.position) : '';
  const items = f.show ? (f.markers ?? []) : [];
  renderList('marker-items', [items, ui.armed], () =>
    items.map((m: Marker) => {
      const row = el('div', 'marker');
      const text = el('span', `grow ellipsis${m.text ? '' : ' mute'}`, m.text || '–');
      if (m.text) text.title = m.text;
      row.append(
        button(formatPosition(m.position), 'marker-seek', () => send({ cmd: 'seekTo', position: m.position }), t('markers.jump')),
        text,
        armButton(`m:${m.id}`, '×', t('common.deleteConfirm'), 'del', () => send({ cmd: 'deleteMarker', id: m.id }), t('markers.delete')),
      );
      return row;
    }),
  );
}

function renderStatsPane(f: FeaturesStatus, visible: boolean) {
  $('lib-st').hidden = !visible;
  if (!visible) return;
  const on = !!f.consent?.statistics?.granted;
  $('stats-enable').hidden = on;
  $('stats-off').hidden = on;
  $('stats-range').hidden = !on;
  $('stats-on').hidden = !on;
  renderSoloBox(f, 'statistics');
  if (!on) return;
  const stats = f.stats;
  $('stats-loading').hidden = !!stats;
  $('stats-cards').hidden = !stats;
  if (!stats) return;
  $('stats-total').textContent = formatDuration(stats.totalSeconds);
  $('stats-together').textContent = formatDuration(stats.togetherSeconds);
  $('stats-alone-card').hidden = !(stats.aloneSeconds > 0 || f.consent?.statistics_solo?.granted);
  $('stats-alone').textContent = formatDuration(stats.aloneSeconds);
  $('stats-top-block').hidden = stats.top.length === 0;
  renderList('stats-top', stats.top, () =>
    stats.top.map((item) => {
      const row = el('div', 'top-item');
      const title = el('span', 'grow ellipsis', item.title ?? item.url);
      title.title = item.title ?? item.url;
      row.append(title, el('span', 'hint', formatDuration(item.seconds)));
      return row;
    }),
  );
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

function renderSettings(s: PopupStatus) {
  const main = ui.settings && !ui.settingsSub;
  $('settings').hidden = !main;
  $('sub-server').hidden = !(ui.settings && ui.settingsSub === 'server');
  $('sub-consents').hidden = !(ui.settings && ui.settingsSub === 'consents');
  if (!ui.settings) return;

  const account = s.account;
  $('settings-account-in').hidden = account.state !== 'signedIn';
  $('settings-account-out').hidden = account.state !== 'signedOut';
  $('settings-account-pending').hidden = account.state !== 'signingIn';
  if (account.state === 'signedIn') {
    const name = s.profile?.username ?? account.name ?? s.name;
    fillAvatar($('settings-avatar'), name, s.profile?.avatarUrl ?? null);
    $('settings-account-name').textContent = s.profile?.username ?? account.name ?? t('settings.accountFallback');
  }

  // Mit Konto ist dessen Benutzername nur ein Vorschlag; ein selbst gewählter Name gilt auch angemeldet
  const nameInput = $<HTMLInputElement>('name-input');
  if (document.activeElement !== nameInput) nameInput.value = ui.draftName ?? s.name;
  $('name-hint').textContent = t(s.nameSuggestion && !s.nameChosen ? 'settings.nameSuggested' : 'settings.nameHint');
  $('name-use-account').hidden = !s.nameSuggestion || !s.nameChosen || s.nameSuggestion === s.name;

  $('auto-follow').setAttribute('aria-checked', String(s.autoFollow));
  for (const value of ['auto', 'de', 'en'] as const) $(`lang-${value}`).setAttribute('aria-pressed', String(s.langSetting === value));

  const consent = s.features.state === 'ready' ? s.features.consent : null;
  // Zusatz-Einwilligungen nur unter erteilter Haupteinwilligung (oder solange sie selbst noch erteilt sind)
  const known = consent
    ? PURPOSES.filter((p) => consent[p] && (!isSoloPurpose(p) || consent[basePurposeOf(p)]?.granted || consent[p]?.granted))
    : [];
  $('go-consents').hidden = known.length === 0;
  const outdatedCount = known.filter((p) => consent?.[p]?.outdated).length;
  $('consent-summary').textContent =
    t('consents.summary', { granted: known.filter((p) => consent?.[p]?.granted).length, total: known.length }) +
    (outdatedCount ? ` · ${t('consents.newVersions', { count: outdatedCount })}` : '');
  const server = ui.draftServer ?? s.serverUrl;
  $('server-short').textContent = s.isDefaultServer && ui.draftServer === null ? t('server.defaultShort') : server;
  $('go-server').classList.toggle('divided', known.length > 0);

  // Server
  const serverInput = $<HTMLInputElement>('server-input');
  if (document.activeElement !== serverInput) serverInput.value = server;
  $('server-kind').textContent = t(s.isDefaultServer && ui.draftServer === null ? 'server.default' : 'server.custom');
  $('reset-server').hidden = s.isDefaultServer && ui.draftServer === null;
  const draft = (ui.draftServer ?? '').trim();
  $<HTMLButtonElement>('server-save').disabled = ui.draftServer === null || !draft || draft === s.serverUrl;

  // Einwilligungen
  if (ui.settingsSub === 'consents' && consent) {
    renderList('consent-list', [known.map((p) => [p, consent[p]?.granted, consent[p]?.grantedAt, consent[p]?.outdated]), ui.armed, appliedLang], () =>
      known.map((purpose) => {
        const c: ConsentView = consent[purpose]!;
        const solo = isSoloPurpose(purpose);
        const row = el('div', `consent-row${solo ? ' sub-row' : ''}`);
        const since = formatDate(c.grantedAt);
        const text = el('div', 'nav-text grow');
        const state = c.granted
          ? `${since ? t('consents.grantedOn', { date: since }) : t('consents.granted')}${c.outdated ? ` · ${t('consents.newVersion')}` : ''}`
          : t('consents.off');
        text.append(el('span', solo ? '' : 'strong-500', solo ? t('solo.label') : purposeLabel(purpose)), el('span', 'hint', state));
        row.append(text);
        if (c.outdated) row.append(button(t('consents.read'), 'consent-btn', () => openConsent(purpose)));
        row.append(
          c.granted
            ? armButton(`c:${purpose}`, t('consents.revoke'), t(solo ? 'consents.revokeSoloConfirm' : 'consents.revokeConfirm'), 'consent-btn granted', () =>
                send({ cmd: 'revokeConsent', purpose }),
              )
            : button(t('consent.accept'), 'consent-btn', () => openConsent(purpose)),
        );
        return row;
      }),
    );
  }
}

function openSettings() {
  if (ui.settings) return;
  ui.settings = true;
  ui.settingsSub = null;
  ui.draftName = null;
  ui.draftServer = null;
  rerender();
}

/** Server direkt auf der Unterseite speichern und zurück zu den Einstellungen. */
function saveServer() {
  const server = (ui.draftServer ?? '').trim();
  if (ui.draftServer !== null && server && server !== lastStatus?.serverUrl) send({ cmd: 'setServer', url: server });
  ui.draftServer = null;
  ui.settingsSub = null;
  rerender();
}

function closeSettings(save: boolean) {
  const s = lastStatus;
  if (save && s) {
    const name = $<HTMLInputElement>('name-input').value;
    if (name.trim() && name !== s.name) send({ cmd: 'setName', name });
    const server = (ui.draftServer ?? '').trim();
    if (ui.draftServer !== null && server && server !== s.serverUrl) send({ cmd: 'setServer', url: server });
  }
  ui.settings = false;
  ui.settingsSub = null;
  ui.draftName = null;
  ui.draftServer = null;
  rerender();
}

// ---------------------------------------------------------------------------
// Einwilligungsdialog (Titel und Text unverändert von der Plattform)
// ---------------------------------------------------------------------------

function openConsent(purpose: Purpose) {
  ui.dialog = { purpose };
  rerender();
  $('consent-accept').focus();
}

function closeConsent() {
  ui.dialog = null;
  rerender();
}

function renderConsentDialog(f: FeaturesStatus) {
  const dialog = ui.dialog;
  const consent = dialog && f.state === 'ready' ? f.consent?.[dialog.purpose] : null;
  // Zusatz-Einwilligung nur zusammen mit der Haupteinwilligung
  const baseMissing = !!dialog && isSoloPurpose(dialog.purpose) && !f.consent?.[basePurposeOf(dialog.purpose)]?.granted;
  if (!dialog || !consent || (consent.granted && !consent.outdated) || baseMissing) {
    // Erteilt, oder die Funktionen sind gerade nicht verfügbar: Dialog schließen
    if (dialog && f.state !== 'loading') ui.dialog = null;
    $('consent-dialog').hidden = true;
    return;
  }
  $('consent-dialog').hidden = false;
  $('consent-title').textContent = consent.title || purposeLabel(dialog.purpose);
  $('consent-outdated').hidden = !consent.outdated;
  const text = $('consent-text');
  if (text.textContent !== consent.text) {
    text.textContent = consent.text;
    text.scrollTop = 0;
  }
  $('consent-version').textContent = t('consent.version', { version: consent.currentVersion });
  $('consent-accept').dataset.version = consent.currentVersion;
  $<HTMLButtonElement>('consent-accept').disabled = f.busy;
  $('consent-error').hidden = !f.error;
  $('consent-error').textContent = f.error ?? '';
}

// ---------------------------------------------------------------------------

function render(s: PopupStatus) {
  lastStatus = s;
  applyLanguage(s.lang);
  // Unteransichten schließen, wenn sie nicht mehr passen (z. B. Raum verlassen, Host-Rolle abgegeben)
  if (!s.inRoom) ui.roomSub = null;
  if (ui.roomSub === 'friends' && !s.social.canInvite) ui.roomSub = null;
  if (ui.roomSub === 'roomSettings' && !s.isHost) ui.roomSub = null;
  if (ui.settingsSub === 'consents' && s.features.state !== 'ready') ui.settingsSub = null;

  renderChrome(s);
  const roomTab = !ui.settings && ui.tab === 'room';
  renderInvites(s.social, s);
  renderLobby(s, roomTab && !s.inRoom && !s.pending);
  renderRoom(s, roomTab && s.inRoom && !ui.roomSub);
  renderMembers(s, roomTab && s.inRoom && ui.roomSub === 'members');
  renderFriends(s, roomTab && s.inRoom && ui.roomSub === 'friends');
  renderRoomSettings(s, roomTab && s.inRoom && ui.roomSub === 'roomSettings');
  renderLibrary(s, !ui.settings && ui.tab === 'library');
  renderSettings(s);
  renderConsentDialog(s.features);
  saveView();
}

// ---------------------------------------------------------------------------
// Ansicht merken: Beim nächsten Öffnen dort weitermachen, wo man war (bis zum Browser-Neustart)
// ---------------------------------------------------------------------------

const VIEW_KEY = 'popupView';
let savedView = '';

function viewState() {
  const { tab, roomSub, settings, settingsSub, libTab, draftName, draftServer } = ui;
  return { tab, roomSub, settings, settingsSub, libTab, draftName, draftServer };
}

function saveView() {
  const view = viewState();
  const json = JSON.stringify(view);
  if (json === savedView) return;
  savedView = json;
  browser.storage.session.set({ [VIEW_KEY]: view }).catch(() => {}); // nur Komfort, Fehler egal
}

/** Gespeicherte Ansicht übernehmen, nur bekannte Werte. Passt sie nicht mehr, korrigiert render() sie. */
async function restoreView() {
  try {
    const { [VIEW_KEY]: raw } = await browser.storage.session.get(VIEW_KEY);
    const v = (raw ?? {}) as Record<string, unknown>;
    const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);
    ui.tab = pick(v.tab, ['room', 'library'] as const, 'room');
    ui.roomSub = pick(v.roomSub, ['members', 'friends', 'roomSettings', null] as const, null);
    ui.settings = v.settings === true;
    ui.settingsSub = ui.settings ? pick(v.settingsSub, ['server', 'consents', null] as const, null) : null;
    ui.libTab = pick(v.libTab, ['wp', 'mk', 'st'] as const, 'wp');
    ui.draftName = ui.settings && typeof v.draftName === 'string' ? v.draftName : null;
    ui.draftServer = ui.settings && typeof v.draftServer === 'string' ? v.draftServer : null;
    savedView = JSON.stringify(viewState());
  } catch {
    // ohne gespeicherte Ansicht: Startseite
  }
}

async function main() {
  const [[tab], lang] = await Promise.all([browser.tabs.query({ active: true, currentWindow: true }), guessLanguage(), restoreView()]);
  applyLanguage(lang);
  const port = browser.runtime.connect({ name: 'popup' });
  port.onMessage.addListener((msg: ToPopup) => {
    if (msg.type === 'status') render(msg.status);
    else if (msg.type === 'avatar') void onAvatar(msg.url, msg.dataUrl);
  });
  send = (cmd) => port.postMessage(cmd);
  // Bilder in langen Listen erst laden, wenn sie sichtbar werden
  avatarObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLElement;
        avatarObserver?.unobserve(target);
        if (target.dataset.avatarUrl) requestAvatars([target.dataset.avatarUrl]);
      }
    },
    { root: $('main-scroll'), rootMargin: '80px' },
  );
  send({ cmd: 'hello', tabId: tab?.id ?? null });
  if (ui.roomSub === 'friends') send({ cmd: 'loadFriends' });

  // Position im Tab für Wiedergabebalken und „Marker setzen“, nur solange das Popup offen ist
  window.setInterval(() => {
    if (lastStatus?.tab.hasVideo) send({ cmd: 'peek' });
  }, PEEK_MS);
  // Restzeit der Einladungen aktuell halten
  window.setInterval(rerender, 30_000);

  const on = (id: string, event: string, handler: (e: Event) => void) => $(id).addEventListener(event, handler);
  const click = (id: string, handler: () => void) => on(id, 'click', handler);
  const submit = (id: string, handler: () => void) =>
    on(id, 'submit', (e) => {
      e.preventDefault();
      handler();
    });

  // Kopf und Reiter
  for (const id of ['login-top', 'login-lobby', 'login-lib', 'login-settings']) click(id, () => send({ cmd: 'login' }));
  click('avatar', openSettings);
  click('gear', openSettings);
  click('tab-room', () => {
    ui.tab = 'room';
    ui.roomSub = null;
    rerender();
  });
  click('tab-library', () => {
    ui.tab = 'library';
    rerender();
  });
  click('notice-close', () => send({ cmd: 'dismissNotice' }));
  // Anmeldung hängt (Tab verloren, Fenster geschlossen): neu starten, ersetzt die offene Anmeldung
  for (const node of document.querySelectorAll('.signing-restart')) node.addEventListener('click', () => send({ cmd: 'login' }));
  click('notice-retry', () => {
    const retry = lastStatus?.notice?.retry;
    if (retry?.action === 'join') send({ cmd: 'join', code: retry.code });
    else if (retry?.action === 'create') send({ cmd: 'create' });
    else if (retry?.action === 'login') send({ cmd: 'login' });
  });

  // Lobby
  click('create', () => send({ cmd: 'create' }));
  on('code-input', 'input', (e) => {
    const input = e.target as HTMLInputElement;
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  submit('join-form', () => send({ cmd: 'join', code: $<HTMLInputElement>('code-input').value }));
  click('cancel', () => send({ cmd: 'cancel' }));

  // Raum
  click('code', async () => {
    if (!lastStatus?.code) return;
    await navigator.clipboard.writeText(lastStatus.code);
    ui.copied = true;
    rerender();
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      ui.copied = false;
      rerender();
    }, 2000);
  });
  click('toggle', () => send({ cmd: 'control', action: 'toggle' }));
  click('back', () => send({ cmd: 'control', action: 'seek', delta: -SEEK_STEP }));
  click('forward', () => send({ cmd: 'control', action: 'seek', delta: SEEK_STEP }));
  click('sync', () => send({ cmd: 'sync' }));
  click('share-content', () => send({ cmd: 'shareContent' }));
  click('open-url', () => send({ cmd: 'openRoomUrl' }));
  click('bind-tab', () => send({ cmd: 'bindTab' }));
  click('leave', () => send({ cmd: 'leave' }));
  const goSub = (sub: RoomSub) => () => {
    ui.roomSub = sub;
    ui.armed = null;
    if (sub === 'friends') send({ cmd: 'loadFriends' });
    rerender();
    $('main-scroll')?.scrollTo(0, 0);
  };
  click('go-members', goSub('members'));
  click('go-friends', goSub('friends'));
  click('members-invite', goSub('friends'));
  click('go-room-settings', goSub('roomSettings'));
  click('max-dec', () => stepMax(-1));
  click('max-inc', () => stepMax(1));
  click('mode-all', () => send({ cmd: 'updateSettings', controlMode: 'all' }));
  click('mode-host', () => send({ cmd: 'updateSettings', controlMode: 'host' }));
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-back]')) {
    b.addEventListener('click', () => {
      if (ui.settings) ui.settingsSub = null;
      else ui.roomSub = null;
      ui.armed = null;
      rerender();
    });
  }

  // Mediathek
  click('progress-enable', () => openConsent('watch_progress'));
  click('markers-enable', () => openConsent('markers'));
  click('stats-enable', () => openConsent('statistics'));
  submit('marker-form', () => {
    const input = $<HTMLInputElement>('marker-text');
    send({ cmd: 'addMarker', text: input.value });
    input.value = '';
  });
  click('lib-outdated-read', () => {
    const first = lastStatus ? outdatedPurposes(lastStatus.features)[0] : undefined;
    if (first) openConsent(first);
  });
  click('relogin', () => send({ cmd: 'relogin' }));
  click('features-retry', () => send({ cmd: 'featuresRefresh' }));
  // Firefox: Host-Berechtigungen sind dort entziehbar und lassen sich nur aus einer Nutzeraktion anfordern
  click('grant-permission', () => {
    browser.permissions.request({ origins: [API_HOST_MATCH] }).then(
      (ok) => ok && send({ cmd: 'featuresRefresh' }),
      (err) => console.warn('Synchrothek: Berechtigung nicht erteilt', err),
    );
  });

  // Einstellungen
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-close-settings]')) b.addEventListener('click', () => closeSettings(false));
  click('settings-save', () => closeSettings(true));
  click('logout', () => send({ cmd: 'logout' }));
  click('name-use-account', () => {
    ui.draftName = null;
    $<HTMLInputElement>('name-input').value = lastStatus?.nameSuggestion ?? '';
    send({ cmd: 'useAccountName' });
  });
  on('name-input', 'input', (e) => {
    ui.draftName = (e.target as HTMLInputElement).value;
    saveView();
  });
  click('auto-follow', () => send({ cmd: 'setAutoFollow', value: !lastStatus?.autoFollow }));
  // Sprache wirkt sofort (nicht erst mit „Speichern“)
  for (const value of ['auto', 'de', 'en'] as const satisfies readonly LangSetting[]) {
    click(`lang-${value}`, () => send({ cmd: 'setLanguage', value }));
  }
  click('go-consents', () => {
    ui.settingsSub = 'consents';
    ui.armed = null;
    rerender();
  });
  click('go-server', () => {
    ui.settingsSub = 'server';
    rerender();
  });
  on('server-input', 'input', (e) => {
    ui.draftServer = (e.target as HTMLInputElement).value;
    rerender();
  });
  on('server-input', 'keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') saveServer();
  });
  click('server-save', saveServer);
  click('reset-server', () => {
    ui.draftServer = null;
    send({ cmd: 'resetServer' });
  });

  // Einwilligungsdialog
  click('consent-accept', () => {
    const version = $('consent-accept').dataset.version;
    if (ui.dialog && version) send({ cmd: 'grantConsent', purpose: ui.dialog.purpose, version });
  });
  click('consent-cancel', closeConsent);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (ui.dialog) closeConsent();
    else if (ui.settingsSub) ui.settingsSub = null;
    else if (ui.settings) closeSettings(false);
    else if (ui.roomSub) ui.roomSub = null;
    else return;
    e.preventDefault();
    rerender();
  });
}

void main();
