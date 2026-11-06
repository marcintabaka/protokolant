// Symulacja content.js: wejście do rozmowy, napisy z inject.js, alias, zapis po wyjściu.
// Uruchom: node tests/content.sim.js   (trwa ok. 8 s – pętla dodatku tyka co 1 s)
const store = { chatNotice: true }; const swMsgs = []; let onMsg; const listeners = {};
let inCall = false;
globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '9.9.9' }), sendMessage: async (m) => { swMsgs.push(m); return { ok: true, filename: 'x.md' }; }, onMessage: { addListener: (f) => (onMsg = f) } },
  storage: { local: { get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; ks.forEach((x) => { if (x in store) o[x] = JSON.parse(JSON.stringify(store[x])); }); return o; }, set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))) }, onChanged: { addListener() {} } },
};
globalThis.Event = class { constructor(t) { this.type = t; } };
// klasyczny czat Meet: ukryte pole wiadomości jest w DOM także przy zamkniętym panelu
globalThis.HTMLTextAreaElement = class { constructor() { this._v = ''; this.tagName = 'TEXTAREA'; } get value() { return this._v; } set value(v) { this._v = v; } dispatchEvent() {} };
const chatInput = new HTMLTextAreaElement();
const sentChat = [];
const sendBtn = { removeAttribute() {}, click() { sentChat.push(chatInput.value); chatInput.value = ''; } };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
const leaveBtn = { getAttribute: () => 'Opuść rozmowę' };
globalThis.document = {
  title: 'Meet - Status projektu',
  querySelector: (sel) => (sel.includes('tooltip') && meetingName ? { innerText: meetingName } : sel.includes('Opuść') && inCall ? leaveBtn : sel.startsWith('textarea') && sel.includes('Wyślij') ? chatInput : sel.startsWith('button') && sel.includes('Wyślij') ? sendBtn : null),
  dispatchEvent: (e) => (listeners[e.type] || []).forEach((f) => f(e)),
  addEventListener: (t, f) => (listeners[t] = listeners[t] || []).push(f),
  documentElement: { getAttribute: () => '1', appendChild() {} },
  createElement: () => ({ style: {} }),
  querySelectorAll: (sel) => (sel === 'iframe' ? (chatOpen ? [chatFrame] : []) : sel === 'button[aria-label]' ? [otherBtn, chatBtn] : []),
};
let meetingName = null; // nazwa spotkania pojawia się w UI z opóźnieniem
let chatOpen = false; const clicks = [];
const otherBtn = { getAttribute: () => 'Szczegóły spotkania', click() { clicks.push('details'); } };
const chatBtn = { getAttribute: () => 'Czatuj ze wszystkimi', click() { chatOpen = !chatOpen; clicks.push(chatOpen ? 'open' : 'close'); } };
const noticeMsgs = [];
const chatFrame = { src: 'https://chat.google.com/frame?x', contentWindow: { postMessage: (d, o) => { noticeMsgs.push([d, o]); setTimeout(() => winL.message.forEach((f) => f({ origin: 'https://chat.google.com', data: { source: 'protokolant-chat', type: 'notice-result', ok: true } })), 10); } } };
globalThis.window = globalThis; const winL = {}; globalThis.addEventListener = (t, f) => (winL[t] = winL[t] || []).push(f);
globalThis.location = { pathname: '/meet/abc-defg-hij' };
require('../extension/common.js'); require('../extension/content.js');
const toCS = []; document.addEventListener('protokolant:cs', (e) => toCS.push(JSON.parse(e.detail)));
const page = (o) => document.dispatchEvent(new CustomEvent('protokolant:page', { detail: JSON.stringify(o) }));
const assert = (c, m) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + m); if (!c) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = () => new Promise((r) => onMsg({ type: 'getStatus' }, {}, r));
const D1 = 'spaces/S/devices/d1', D2 = 'spaces/S/devices/d2';
(async () => {
  page({ type: 'status', devices: { [D1]: 'Marcin Tabaka' }, selfDevice: D1, channels: [{ label: 'captions_v2', origin: 'own', state: 'open', current: true }], counts: {} });
  inCall = true; await sleep(1300);
  assert(toCS.some((c) => c.type === 'start' && c.language === 'pl-PL'), 'po wejściu wysłano start z językiem pl-PL');
  page({ type: 'caption', mid: '1/' + D1, deviceId: D1, version: 1, text: 'Dzień' });
  page({ type: 'caption', mid: '1/' + D1, deviceId: D1, version: 3, text: 'Dzień dobry wszystkim' });
  page({ type: 'caption', mid: '1/' + D1, deviceId: D1, version: 2, text: 'Dzień dobry' }); // spóźniona starsza wersja
  page({ type: 'caption', mid: '2/' + D2, deviceId: D2, version: 1, text: 'Cześć' });
  page({ type: 'device', deviceId: D2, name: 'Jan Kowalski' });
  page({ type: 'caption', mid: '9/' + D2, deviceId: D2, version: 1, text: 'Cześć' }); // duplikat z innego kanału
  page({ type: 'alias', from: '9/' + D2, to: '2/' + D2 });
  page({ type: 'chat', id: 'spaces/S/messages/m1', deviceId: D2, text: 'https://example.com', source: 'collections' });
  page({ type: 'chat', id: 'spaces/S/messages/m1', deviceId: D2, text: 'https://example.com', source: 'meet_messages' }); // ten sam ID
  winL.message.forEach((f) => f({ origin: 'https://chat.google.com', data: { source: 'protokolant-chat', type: 'own-message', text: 'mój link' } }));
  page({ type: 'chat', id: 'x/own', deviceId: D1, text: 'mój link', source: 'collections' }); // echo własnej wiadomości
  page({ type: 'caption', mid: '3/' + D1, deviceId: D1, version: 1, text: 'po czacie' });
  const st = await status();
  assert(st.code === 'abc-defg-hij' && st.title === 'Status projektu', `kod i tytuł z karty: ${st.code} / ${st.title}`);
  meetingName = 'Szczegóły spotkania'; // ogólna etykieta – ignorujemy
  await sleep(5200);
  assert((await status()).title === 'Status projektu', 'ogólna etykieta „Szczegóły spotkania” nie zastępuje nazwy');
  meetingName = 'Klient<>Dostawca (status zadań)';
  assert(st.level === 'on' && st.entries === 3 && st.chats === 2, `status: ${st.level}, wypowiedzi ${st.entries}, czat ${st.chats}`);
  const s = await new Promise((r) => onMsg({ type: 'getSession', since: null }, {}, r));
  const lines = Protokolant.formatEntries(s).map((e) => `${e.speaker}${e.chat ? ' (czat)' : ''}: ${e.text}`);
  const want = ['Marcin Tabaka: Dzień dobry wszystkim', 'Jan Kowalski: Cześć', 'Jan Kowalski (czat): https://example.com', 'Marcin Tabaka (czat): mój link', 'Marcin Tabaka: po czacie'];
  assert(JSON.stringify(lines) === JSON.stringify(want), 'wpisy: ' + JSON.stringify(lines));
  assert((await new Promise((r) => onMsg({ type: 'getSession', since: s.updatedAt }, {}, r))) === null, 'getSession bez zmian zwraca null');
  await sleep(5200); // powiadomienie startuje 5 s po wejściu, gdy kanał napisów działa
  await sleep(800);
  assert(sentChat.length === 1 && sentChat[0].startsWith('ℹ️ Ta rozmowa jest transkrybowana'), 'powiadomienie wysłane przez pole czatu Meet: ' + JSON.stringify(sentChat));
  assert(clicks.length === 0 && noticeMsgs.length === 0, 'bez otwierania panelu i bez ramki: ' + JSON.stringify(clicks));
  const st2 = await status();
  assert(/^wysłane .*pole czatu w tle/.test(st2.notice), 'status powiadomienia w popupie: ' + st2.notice);
  const s2 = await new Promise((r) => onMsg({ type: 'getSession', since: null }, {}, r));
  assert(s2.noticeSentAt > 0, 'zapamiętano wysłanie powiadomienia (bez powtórek)');
  // użytkownik klika „Opuść rozmowę”; Meet zamyka kanał, zanim zniknie UI
  listeners.click.forEach((f) => f({ target: { closest: () => leaveBtn } }));
  page({ type: 'status', devices: {}, channels: [{ label: 'captions_v2', origin: 'own', state: 'closed', current: true }], counts: {} });
  const st3 = await status();
  assert(st3.level === 'ending', 'po kliknięciu Opuść stan „kończenie”, nie błąd: ' + st3.level);
  inCall = false; await sleep(1500);
  const st4 = await status();
  assert(st4.level === 'ending', 'UI rozmowy zniknęło – nadal „kończenie”: ' + st4.level);
  await sleep(5000);
  const iconsEnd = swMsgs.filter((m) => m.type === 'icon').slice(-4).map((m) => m.icon + (m.badge || ''));
  assert(!iconsEnd.some((i) => i.includes('!') || i === 'warn'), 'przy wychodzeniu brak ikony błędu: ' + iconsEnd.join(','));
  const icons = swMsgs.filter((m) => m.type === 'icon').map((m) => m.icon + (m.badge || ''));
  const blink = icons.filter((i) => i === 'rec' || i === 'dim');
  assert(blink.length >= 6 && blink.every((v, i) => i === 0 || v !== blink[i - 1]), 'ikona mruga rec/dim w trakcie rozmowy: ' + blink.slice(0, 6).join(','));
  assert(icons[icons.length - 1] === 'idle', 'po wyjściu ikona wraca do spoczynku: ' + icons.slice(-3).join(','));
  const saves = swMsgs.filter((m) => m.type === 'saveSession').map((m) => m.reason);
  assert(JSON.stringify(saves) === JSON.stringify(['leave-click', 'call-ui-gone']), 'zapis po kliknięciu Opuść i po zniknięciu UI (drugi pomijany, jeśli bez zmian): ' + saves);
  const stored = store['session:abc-defg-hij_' + Protokolant.localDate(Date.now())];
  assert(stored && stored.endedAt && stored.entries.length === 5, 'bufor w storage z końcem rozmowy');
  assert(stored.title === 'Klient<>Dostawca (status zadań)', 'nazwa spotkania z dolnego paska Meet: ' + stored.title);
  assert(Protokolant.sessionFilename(stored).endsWith('_abc-defg-hij.md'), 'nazwa pliku z kodem: ' + Protokolant.sessionFilename(stored));
  assert(Protokolant.buildMarkdown(stored).startsWith('# Klient<>Dostawca (status zadań)\n'), 'tytuł pliku = nazwa spotkania');
  console.log('\n' + Protokolant.buildMarkdown(stored).split('\n').slice(0, 6).join('\n'));
  process.exit();
})();
