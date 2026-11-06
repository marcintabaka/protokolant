/*
 * Content script dla meet.google.com (świat izolowany).
 *
 * Napisy przychodzą z inject.js (świat strony), który czyta kanały WebRTC Meet.
 * Ten skrypt wykrywa wejście do rozmowy i wyjście z niej, składa wypowiedzi
 * (ID + wersja, nowsza wersja zastępuje starszą), trzyma bufor w
 * chrome.storage.local i zleca zapis pliku service workerowi.
 *
 * Tryb odczytu napisów z ekranu (DOM) usunięto w v0.3; ostatnia wersja z nim
 * jest w gicie pod tagiem dom-mode-last.
 */
(() => {
  'use strict';
  if (window.__protokolantLoaded) return;
  window.__protokolantLoaded = true;

  const MT = globalThis.Protokolant;
  const TAG = '[Protokolant]';
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // Selektory DOM – tylko do wykrywania rozmowy i tytułu.
  const SELECTORS = {
    // Obecność przycisku „Opuść rozmowę” = jesteśmy w rozmowie.
    leaveButton: ['button[aria-label*="Leave call" i]', 'button[aria-label*="Opuść rozmowę" i]', 'button[jsname="CQylAd"]'],
    // Nazwa spotkania (zwykle tytuł wydarzenia z kalendarza), sprawdzana po kolei.
    meetingTitle: [
      { sel: '[data-meeting-title]:not([data-meeting-title=""]) [role="tooltip"]', text: true },
      { sel: '[data-meeting-title]:not([data-meeting-title=""])', attr: 'data-meeting-title' },
      { sel: '.Jyj1Td', text: true },
    ],
    // Etykiety, które Meet pokazuje zamiast nazwy, gdy spotkanie jej nie ma.
    genericTitle: /^(google\s+)?meet$|^(meeting details|szczegóły spotkania|ready to join\?|gotowy do dołączenia\?|czy chcesz dołączyć\?)$/i,
  };

  const TIMING = {
    tickMs: 1000,
    persistMs: 3000,
    leaveGraceMs: 4000,
    connectGraceMs: 15000,
    titleMs: 5000,
  };

  const DEFAULT_LANGUAGE = 'pl-PL';
  const NOTICE_TEXT = 'ℹ️ Ta rozmowa jest transkrybowana (Protokolant – transkrypcje dla Google Meet™, zapis lokalny).';
  // Przycisk panelu czatu w Meet (PL/EN).
  const CHAT_BUTTON_LABEL = /^(czatuj ze wszystkimi|chat with everyone|czat|chat)\b/i;
  const DEBUG_LOG_MAX = 5000;

  const state = {
    dead: false,
    inCall: false,
    joining: false,
    leaving: false,
    joinedAt: 0,
    lastInCallSeen: 0,
    session: null,
    dirty: false,
    lastPersist: 0,
    nextId: 1,
    entryByMid: new Map(),
    pending: [],
    devices: {},
    selfDevice: null,
    rtc: null, // ostatni status z inject.js
    lastTitleAt: 0,
    lastCaptionAt: 0,
    lastCaptionText: '',
    language: DEFAULT_LANGUAGE,
    chatNotice: false, // opcja: powiadom uczestników na czacie o transkrypcji
    noticeBusy: false,
    noticeTriedAt: 0,
    noticeStatus: '',
    endingAt: 0, // kliknięto „Opuść rozmowę” – zamykanie kanałów to nie błąd
    endedInfo: null, // { text, until } – potwierdzenie zapisu po wyjściu
    debug: false,
    debugLog: [],
    badgeKey: '',
  };

  // ---------------------------------------------------------------------
  // Narzędzia
  // ---------------------------------------------------------------------
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function qFirst(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (e) {
        /* niepoprawny selektor */
      }
    }
    return null;
  }

  function dbg(kind, data) {
    if (!state.debug) return;
    state.debugLog.push({ t: Date.now(), kind, ...data });
    if (state.debugLog.length > DEBUG_LOG_MAX) state.debugLog.splice(0, state.debugLog.length - DEBUG_LOG_MAX);
  }

  function isInvalidated(e) {
    return /context invalidated/i.test(String(e));
  }

  async function sendToSW(msg) {
    if (state.dead) return { ok: false, error: 'extension-reloaded' };
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (isInvalidated(e)) {
        state.dead = true;
        warn('Dodatek został przeładowany. Odśwież kartę Meet (F5), żeby znów działał.');
        renderOverlay();
      } else {
        warn('Błąd komunikacji z service workerem:', e);
      }
      return { ok: false, error: String(e) };
    }
  }

  function meetingCode() {
    // Meet używa adresów /abc-defg-hij oraz /meet/abc-defg-hij.
    const m = location.pathname.match(/^\/(?:meet\/)?([a-z0-9]+-[a-z0-9]+-[a-z0-9]+)(?:$|[/?#])/i);
    if (m) return m[1].toLowerCase();
    const segs = location.pathname.split('/').filter(Boolean).filter((s) => s !== 'meet');
    return (segs[0] || 'unknown').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  }

  // Zwraca nazwę spotkania albo kod, gdy spotkanie nie ma nazwy.
  function readTitle(code) {
    const candidates = SELECTORS.meetingTitle.map((c) => () => {
      const el = document.querySelector(c.sel);
      if (!el) return '';
      return c.attr ? el.getAttribute(c.attr) : el.innerText || el.textContent;
    });
    candidates.push(() => document.title.replace(/^\s*(Google\s+)?Meet\s*[-–—:]\s*/i, ''));
    for (const get of candidates) {
      let t = '';
      try {
        t = norm(get());
      } catch (e) {
        continue;
      }
      if (t && !SELECTORS.genericTitle.test(t) && !t.toLowerCase().includes(code)) return t;
    }
    return code;
  }

  function markChanged() {
    state.dirty = true;
    if (state.session) {
      state.session.updatedAt = Date.now();
      state.session.endedAt = null;
    }
  }

  // ---------------------------------------------------------------------
  // Komunikacja z inject.js (świat strony)
  // ---------------------------------------------------------------------
  function sendToPage(type, data = {}) {
    document.dispatchEvent(new CustomEvent('protokolant:cs', { detail: JSON.stringify({ type, ...data }) }));
  }

  function pageConfig() {
    return { language: state.language || null, debug: state.debug };
  }

  function hookInstalled() {
    return document.documentElement.getAttribute('data-protokolant-hook') === '1';
  }

  function rememberDevice(deviceId, name) {
    if (!deviceId || !name) return;
    state.devices[deviceId] = name;
    const s = state.session;
    if (s && s.devices[deviceId] !== name) {
      s.devices[deviceId] = name;
      state.dirty = true;
    }
  }

  function rememberSelf(deviceId) {
    if (!deviceId) return;
    state.selfDevice = deviceId;
    if (state.session && state.session.selfDevice !== deviceId) {
      state.session.selfDevice = deviceId;
      state.dirty = true;
    }
  }

  function applyCaption(m, now) {
    const text = norm(m.text);
    if (!text) return;
    let e = state.entryByMid.get(m.mid);
    if (!e) {
      e = { id: state.nextId++, mid: m.mid, ts: now, deviceId: m.deviceId, speaker: state.devices[m.deviceId] || null, version: m.version, text, endTs: now };
      state.session.entries.push(e);
      state.entryByMid.set(m.mid, e);
      dbg('utterance-new', { mid: m.mid, ch: m.ch, version: m.version, text });
    } else {
      if (m.version < e.version) return;
      if (m.version === e.version && text === e.text) return;
      e.version = m.version;
      e.endTs = now;
      e.text = text;
      dbg('utterance-update', { mid: m.mid, ch: m.ch, version: m.version, text });
    }
    if (!e.speaker && state.devices[m.deviceId]) e.speaker = state.devices[m.deviceId];
    state.lastCaptionAt = now;
    state.lastCaptionText = `${e.speaker || 'Uczestnik'}: ${text}`;
    markChanged();
  }

  // Ta sama wypowiedź przyszła dwoma kanałami pod różnymi ID – scalamy wpisy.
  function mergeAlias(from, to) {
    if (!state.session) {
      for (const p of state.pending) if (p.mid === from) p.mid = to;
      return;
    }
    const a = state.entryByMid.get(from);
    if (!a) return;
    const b = state.entryByMid.get(to);
    const entries = state.session.entries;
    state.entryByMid.delete(from);
    if (b && b !== a) {
      b.ts = Math.min(a.ts, b.ts);
      if (a.version > b.version) {
        b.version = a.version;
        b.text = a.text;
      }
      entries.splice(entries.indexOf(a), 1);
      entries.splice(entries.indexOf(b), 1);
      const k = entries.findIndex((e) => e.ts > b.ts);
      entries.splice(k < 0 ? entries.length : k, 0, b);
    } else {
      a.mid = to;
      state.entryByMid.set(to, a);
    }
    dbg('alias-merge', { from, to });
    markChanged();
  }

  // Wiadomość z czatu: ze strony Meet (kanały WebRTC, odpowiedź CreateMeetingMessage)
  // albo z ramki Google Chat (własne wysłane). Dedup po ID i po treści (15 s).
  function addChat(c, now) {
    const text = norm(c.text);
    if (!text) return;
    const key = c.id ? `chat:${c.id}` : null;
    if (key && state.entryByMid.has(key)) return;
    const dup = state.session.entries.slice(-50).find((e) => e.chat && e.text === text && Math.abs(e.ts - now) < 15000);
    if (dup) {
      if (key) state.entryByMid.set(key, dup);
      if (c.deviceId && !dup.deviceId) dup.deviceId = c.deviceId;
      return;
    }
    const deviceId = c.deviceId || state.selfDevice || null;
    const e = { id: state.nextId++, chat: true, ts: now, deviceId, speaker: deviceId ? state.devices[deviceId] || null : null, text };
    if (key) {
      e.mid = key;
      state.entryByMid.set(key, e);
    }
    state.session.entries.push(e);
    log(`czat (${c.source || '?'}): ${e.speaker || 'Ty'}: ${text.slice(0, 80)}`);
    dbg('chat', { source: c.source, id: c.id, deviceId, text });
    markChanged();
    maybePersist();
  }

  let chatDumpResolve = null;
  let noticeResolve = null;
  function onFrameMessage(ev) {
    if (ev.origin !== 'https://chat.google.com' || !ev.data || ev.data.source !== 'protokolant-chat') return;
    const d = ev.data;
    if (d.type === 'own-message') {
      if (state.session && !state.joining) addChat({ text: d.text, source: 'chat-frame' }, Date.now());
    } else if (d.type === 'notice-result' && noticeResolve) {
      noticeResolve(d);
      noticeResolve = null;
    } else if (d.type === 'dump' && chatDumpResolve) {
      chatDumpResolve(d);
      chatDumpResolve = null;
    }
  }

  async function dumpChat() {
    const frames = [...document.querySelectorAll('iframe')].filter((f) => /chat\.google\.com/.test(f.src || ''));
    if (!frames.length) return { ok: false, error: 'Nie widzę ramki czatu – otwórz panel czatu w Meet i spróbuj ponownie.' };
    const d = await new Promise((resolve) => {
      chatDumpResolve = resolve;
      frames.forEach((f) => f.contentWindow.postMessage({ source: 'protokolant', type: 'dump-chat' }, 'https://chat.google.com'));
      setTimeout(() => resolve(null), 3000);
    });
    if (!d) return { ok: false, error: 'Ramka czatu nie odpowiedziała (odśwież kartę Meet po aktualizacji dodatku).' };
    const now = Date.now();
    const content = `<!-- Protokolant ${MT.VERSION} zrzut ramki czatu ${new Date(now).toISOString()} url=${d.url} -->\n` +
      `<!-- ostatnie żądania:\n${d.requests.join('\n').replace(/--/g, '- -')}\n-->\n${d.html}`;
    return sendToSW({
      type: 'download',
      filename: `${MT.DOWNLOAD_DIR}/debug/chat_${MT.localDate(now)}_${MT.localTime(now).replace(/:/g, '')}.html`,
      content,
      mime: 'text/html',
    });
  }

  function onPageEvent(ev) {
    let m;
    try {
      m = JSON.parse(ev.detail);
    } catch (e) {
      return;
    }
    switch (m.type) {
      case 'caption':
        if (!state.session || state.joining) {
          if (state.pending.length < 5000) state.pending.push(m);
          return;
        }
        try {
          applyCaption(m, Date.now());
          maybePersist();
        } catch (e) {
          warn('Błąd przetwarzania napisu:', e);
        }
        break;
      case 'chat':
        if (!state.session || state.joining) {
          if (state.pending.length < 5000) state.pending.push(m);
          return;
        }
        addChat(m, Date.now());
        break;
      case 'alias':
        mergeAlias(m.from, m.to);
        break;
      case 'device':
        rememberDevice(m.deviceId, m.name);
        break;
      case 'self':
        rememberSelf(m.deviceId);
        break;
      case 'status':
        state.rtc = m;
        for (const [id, name] of Object.entries(m.devices || {})) rememberDevice(id, name);
        if (m.selfDevice) rememberSelf(m.selfDevice);
        break;
      case 'raw':
        dbg('rtc-raw', m);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------
  // Powiadomienie uczestników na czacie (opcja, domyślnie wyłączona)
  // ---------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findChatFrame() {
    return [...document.querySelectorAll('iframe')].find((f) => /chat\.google\.com/.test(f.src || '')) || null;
  }

  function findChatButton() {
    return [...document.querySelectorAll('button[aria-label]')].find((b) => CHAT_BUTTON_LABEL.test(b.getAttribute('aria-label'))) || null;
  }

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(250);
    }
    return null;
  }

  function askFrameToSend(frame) {
    return new Promise((resolve) => {
      noticeResolve = resolve;
      frame.contentWindow.postMessage({ source: 'protokolant', type: 'send-notice', text: NOTICE_TEXT }, 'https://chat.google.com');
      setTimeout(() => {
        if (noticeResolve === resolve) {
          noticeResolve = null;
          resolve(null);
        }
      }, 15000);
    });
  }

  // Czat w Meet: klasyczny panel (textarea w DOM strony) albo ramka Google Chat.
  const CHAT_INPUT = ['textarea[aria-label="Wyślij wiadomość" i]', 'textarea[aria-label*="send a message" i]', 'textarea[jsname="YPqjbf"]'];
  const CHAT_SEND = ['button[aria-label="Wyślij wiadomość" i]', 'button[aria-label="Send message" i]', 'button[aria-label*="send a message" i]', 'button[jsname="SoqoBf"]'];

  async function sendViaFrame(frame) {
    let r = null;
    // skrypt w ramce mógł się jeszcze nie załadować – ponawiamy
    for (let i = 0; i < 5 && !r; i++) {
      r = await askFrameToSend(frame);
      if (!r) await sleep(1500);
    }
    return r || { ok: false, error: 'brak odpowiedzi ramki czatu' };
  }

  // Klasyczny czat Meet: wpisujemy tekst w pole (także ukryte, przy zamkniętym panelu)
  // i klikamy „Wyślij”. Sukces = Meet wyczyścił pole po wysłaniu.
  async function sendViaMeetInput(input) {
    if (input.value && input.value.trim()) return { ok: false, error: 'pole wiadomości nie jest puste – nie nadpisuję' };
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setValue.call(input, NOTICE_TEXT);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    const send = qFirst(CHAT_SEND);
    if (!send) {
      setValue.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: false, error: 'nie znalazłem przycisku „Wyślij wiadomość”' };
    }
    send.removeAttribute('disabled');
    send.click();
    const cleared = await waitFor(() => !input.value, 5000);
    return cleared ? { ok: true } : { ok: false, error: 'Meet nie wysłał wiadomości (pole nie zostało wyczyszczone)' };
  }

  async function sendChatNotice() {
    const s = state.session;
    if (!s || s.noticeSentAt || state.noticeBusy) return;
    state.noticeBusy = true;
    state.noticeTriedAt = Date.now();
    let opened = false;
    let r;
    try {
      let target = qFirst(CHAT_INPUT) || findChatFrame();
      if (!target) {
        // pola czatu nie ma w DOM – otwieramy panel czatu na chwilę
        const btn = findChatButton();
        if (!btn) throw new Error('nie znalazłem przycisku czatu');
        btn.click();
        opened = true;
        target = await waitFor(() => qFirst(CHAT_INPUT) || findChatFrame(), 8000);
        if (!target) throw new Error('po otwarciu panelu nie znalazłem pola wiadomości');
      }
      r = target.tagName === 'IFRAME' ? await sendViaFrame(target) : await sendViaMeetInput(target);
      r.via = target.tagName === 'IFRAME' ? 'ramka czatu' : opened ? 'panel czatu (otwarty na chwilę)' : 'pole czatu w tle';
    } catch (e) {
      r = { ok: false, error: e.message || String(e) };
    } finally {
      if (opened) {
        await sleep(800);
        const btn = findChatButton();
        if (btn) btn.click();
      }
      state.noticeBusy = false;
    }
    const at = MT.localTime(Date.now());
    if (r.ok) {
      s.noticeSentAt = Date.now();
      state.dirty = true;
      state.noticeStatus = `wysłane ${at} (${r.via})`;
      log(`wysłano na czacie powiadomienie o transkrypcji (${r.via})`);
    } else {
      state.noticeStatus = `błąd ${at}: ${r.error} – ponowię za 2 min`;
      warn('nie udało się wysłać powiadomienia o transkrypcji:', r.error);
    }
  }

  function maybeSendChatNotice() {
    // raz na spotkanie (po ponownym dołączeniu nie powtarzamy), po otwarciu kanału napisów;
    // przy niepowodzeniu kolejna próba najwcześniej po 2 minutach
    if (!state.chatNotice || !state.session || state.session.noticeSentAt || state.noticeBusy) return;
    if (Date.now() - state.noticeTriedAt < 120000) return;
    if (Date.now() - state.joinedAt < 5000 || rtcLevel() !== 'on') return;
    sendChatNotice();
  }

  function rtcLevel() {
    if (!hookInstalled()) return 'no-hook';
    // Wyjście ze spotkania: Meet zamyka połączenie, zanim zniknie UI rozmowy.
    if (state.inCall && ((state.endingAt && Date.now() - state.endingAt < 15000) || !qFirst(SELECTORS.leaveButton))) return 'ending';
    const r = state.rtc;
    const c = (r && r.counts) || {};
    const raw = ((c.captions && c.captions.raw) || 0) + ((c.captions_v2 && c.captions_v2.raw) || 0);
    const ok = ((c.captions && c.captions.caption) || 0) + ((c.captions_v2 && c.captions_v2.caption) || 0);
    if (raw >= 5 && ok === 0) return 'undecodable';
    if (r && r.channels && r.channels.some((ch) => ch.current && ch.state === 'open')) return 'on';
    if (Date.now() - state.joinedAt < TIMING.connectGraceMs) return 'connecting';
    return 'no-channel';
  }

  // ---------------------------------------------------------------------
  // Sesja: wejście, zapis bufora, wyjście
  // ---------------------------------------------------------------------
  async function onJoin() {
    state.joining = true;
    try {
      const now = Date.now();
      const code = meetingCode();
      const key = `${code}_${MT.localDate(now)}`;
      const skey = MT.SESSION_PREFIX + key;
      let s = (await chrome.storage.local.get(skey))[skey];
      if (s) {
        state.nextId = s.entries.reduce((mx, e) => Math.max(mx, e.id || 0), 0) + 1;
        s.entries.push({ id: state.nextId++, ts: now, marker: 'ponowne dołączenie do spotkania' });
        s.endedAt = null;
        log(`ponowne wejście na spotkanie ${code}, dopisuję do istniejącej transkrypcji (${s.entries.length} wpisów)`);
      } else {
        s = { key, code, title: readTitle(code), startedAt: now, endedAt: null, updatedAt: now, selfDevice: null, devices: {}, entries: [], version: MT.VERSION };
        state.nextId = 1;
        log(`nowa transkrypcja: ${s.title} (${code})`);
      }
      s.devices = { ...(s.devices || {}), ...state.devices };
      if (state.selfDevice) s.selfDevice = state.selfDevice;
      state.entryByMid = new Map(s.entries.filter((e) => e.mid).map((e) => [e.mid, e]));
      state.session = s;
      state.inCall = true;
      state.joinedAt = now;
      state.endingAt = 0;
      state.endedInfo = null;
      state.lastInCallSeen = now;
      state.dirty = true;
      sendToPage('start', pageConfig());
      await persist(true);
      sendToSW({ type: 'register', key });
    } catch (e) {
      warn('Błąd przy wejściu do rozmowy:', e);
      if (isInvalidated(e)) state.dead = true;
    } finally {
      state.joining = false;
      flushPending();
    }
  }

  function flushPending() {
    if (!state.session || !state.pending.length) return;
    const list = state.pending;
    state.pending = [];
    for (const m of list) {
      try {
        if (m.type === 'chat') addChat(m, Date.now());
        else applyCaption(m, Date.now());
      } catch (e) {
        warn(e);
      }
    }
  }

  async function persist(force) {
    const s = state.session;
    if (!s || state.dead) return;
    if (!force && !state.dirty) return;
    state.dirty = false;
    state.lastPersist = Date.now();
    try {
      await chrome.storage.local.set({ [MT.SESSION_PREFIX + s.key]: s });
    } catch (e) {
      state.dirty = true;
      if (isInvalidated(e)) {
        state.dead = true;
        renderOverlay();
      }
      warn('Nie udało się zapisać bufora:', e);
    }
  }

  function maybePersist() {
    if (state.dirty && Date.now() - state.lastPersist > TIMING.persistMs) persist(false);
  }

  async function saveNow(reason, onlyIfChanged = false) {
    if (!state.session) return { ok: false, error: 'Brak transkrypcji w tej karcie (nie jesteś w rozmowie?)' };
    await persist(true);
    const r = await sendToSW({ type: 'saveSession', key: state.session.key, reason, onlyIfChanged });
    if (r && r.ok && !r.skipped) log(`zapisano plik: ${r.filename} (powód: ${reason})`);
    else if (r && r.skipped) log(`bez zmian od ostatniego zapisu, pomijam (powód: ${reason})`);
    else warn('zapis pliku nie powiódł się:', r);
    return r;
  }

  async function onLeave(reason) {
    if (!state.inCall || state.leaving) return;
    state.leaving = true;
    try {
      log(`koniec rozmowy (${reason}), zapisuję transkrypcję`);
      if (!state.session.endedAt) {
        state.session.endedAt = state.session.updatedAt = Date.now();
        state.dirty = true;
      }
      const r = await saveNow(reason, true);
      const until = Date.now() + 10000;
      if (r && r.ok) {
        const file = r.filename || MT.sessionFilename(state.session);
        state.endedInfo = { text: `✔ Protokolant: transkrypcja zapisana – Pobrane/${file}`, level: 'done', until };
      } else {
        state.endedInfo = { text: '⚠ Protokolant: nie udało się zapisać pliku – pobierz transkrypcję z popupu dodatku', level: 'bad', until: Date.now() + 30000 };
      }
    } finally {
      sendToPage('stop');
      state.inCall = false;
      state.leaving = false;
      updateBadge();
    }
  }

  function onDocumentClick(e) {
    if (!state.inCall) return;
    const t = e.target && e.target.closest && e.target.closest(SELECTORS.leaveButton.join(','));
    if (!t) return;
    // Zapis od razu, zanim Meet rozbierze UI rozmowy.
    state.endingAt = Date.now();
    renderOverlay();
    updateBadge();
    if (state.session) {
      state.session.endedAt = state.session.updatedAt = Date.now();
      state.dirty = true;
    }
    saveNow('leave-click', true);
  }

  // ---------------------------------------------------------------------
  // Status, nakładka na stronie, badge
  // ---------------------------------------------------------------------
  function countUtterances(s) {
    return MT.formatEntries(s).filter((e) => !e.marker && !e.chat).length;
  }

  function getStatus() {
    const s = state.session;
    const r = state.rtc;
    return {
      version: MT.VERSION,
      dead: state.dead,
      inCall: state.inCall,
      code: s ? s.code : meetingCode(),
      title: s ? s.title : null,
      key: s ? s.key : null,
      updatedAt: s ? s.updatedAt : 0,
      entries: s ? countUtterances(s) : 0,
      lastCaptionAt: state.lastCaptionAt,
      lastCaptionText: state.lastCaptionText.slice(-160),
      level: rtcLevel(),
      language: state.language,
      rtc: r ? { mainPc: r.mainPc, pcState: r.pcState, channels: r.channels, counts: r.counts, mediaSession: r.mediaSession, errors: r.errors } : null,
      devices: Object.keys(state.devices).length,
      selfName: state.selfDevice ? state.devices[state.selfDevice] || null : null,
      chats: s ? s.entries.filter((e) => e.chat).length : 0,
      notice: state.chatNotice ? (s && s.noticeSentAt ? state.noticeStatus || 'wysłane' : state.noticeStatus || 'czeka na start transkrypcji') : null,
      debug: state.debug,
      debugEvents: state.debugLog.length,
    };
  }

  function statusView() {
    if (state.dead) return { text: '⚠ Protokolant: dodatek przeładowany – odśwież kartę (F5)', level: 'bad', badge: '!' };
    if (!state.inCall) {
      if (state.endedInfo && Date.now() < state.endedInfo.until) return { text: state.endedInfo.text, level: state.endedInfo.level };
      return null;
    }
    const n = state.session ? countUtterances(state.session) : 0;
    switch (rtcLevel()) {
      case 'ending':
        return { text: `■ Protokolant: kończę transkrypcję (${n} wypowiedzi) i zapisuję plik…`, level: 'end' };
      case 'on':
        return { text: `● Transkrypcja: ${n} wypowiedzi`, level: 'ok', badge: 'REC' };
      case 'connecting':
        return { text: '… Protokolant: łączę z kanałem napisów', level: 'warn', badge: '…' };
      case 'undecodable':
        return { text: '⚠ Protokolant: pakiety napisów przychodzą, ale nie umiem ich odczytać (zmiana formatu Meet?). Popup → log debug.', level: 'bad', badge: '!' };
      case 'no-hook':
        return { text: '⚠ Protokolant: brak hooka WebRTC – odśwież kartę (F5). Transkrypcja NIE jest zapisywana.', level: 'bad', badge: '!' };
      default:
        return { text: '⚠ Protokolant: brak kanału napisów – transkrypcja NIE jest zapisywana. Odśwież kartę (F5).', level: 'bad', badge: '!' };
    }
  }

  let overlayEl = null;
  function renderOverlay() {
    const v = statusView();
    if (!v) {
      if (overlayEl) overlayEl.style.display = 'none';
      return;
    }
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'protokolant-overlay';
      Object.assign(overlayEl.style, {
        position: 'fixed',
        left: '12px',
        bottom: '92px',
        zIndex: '2147483647',
        padding: '4px 10px',
        borderRadius: '12px',
        font: '12px/1.4 system-ui, sans-serif',
        color: '#fff',
        pointerEvents: 'none',
        maxWidth: '420px',
        boxShadow: '0 1px 4px rgba(0,0,0,.4)',
      });
      document.documentElement.appendChild(overlayEl);
    }
    overlayEl.style.display = 'block';
    const BG = { ok: 'rgba(20,110,50,.75)', done: 'rgba(20,110,50,.9)', end: 'rgba(60,64,67,.85)', warn: 'rgba(160,110,0,.9)' };
    overlayEl.style.background = BG[v.level] || 'rgba(190,30,30,.95)';
    overlayEl.textContent = v.text;
  }

  // Ikona na pasku: szara kropka poza rozmową, czerwona mrugająca podczas transkrypcji,
  // pomarańczowa przy łączeniu, pomarańczowa z „!” przy problemie.
  const BLINK_MS = 600;
  let blinkOn = true;

  function updateBadge() {
    const v = statusView();
    let icon = 'idle';
    let badge = '';
    if (!v || v.level === 'end' || v.level === 'done') icon = 'idle';
    else if (v.level === 'ok') icon = blinkOn ? 'rec' : 'dim';
    else if (v.level === 'warn') icon = 'warn';
    else {
      icon = 'warn';
      badge = '!';
    }
    const k = `${icon}|${badge}`;
    if (k === state.badgeKey) return;
    state.badgeKey = k;
    sendToSW({ type: 'icon', icon, badge });
  }

  setInterval(() => {
    if (!state.inCall || state.dead) return;
    blinkOn = !blinkOn;
    updateBadge();
  }, BLINK_MS);

  // ---------------------------------------------------------------------
  // Log debug
  // ---------------------------------------------------------------------
  async function downloadDebugLog() {
    if (!state.debugLog.length) return { ok: false, error: 'Log debug jest pusty (włącz tryb debug i poczekaj na napisy).' };
    let lines = state.debugLog.map((e) => JSON.stringify(e));
    let content = lines.join('\n');
    while (content.length > 900000 && lines.length > 100) {
      lines = lines.slice(Math.floor(lines.length / 4));
      content = lines.join('\n');
    }
    const now = Date.now();
    return sendToSW({
      type: 'download',
      filename: `${MT.DOWNLOAD_DIR}/debug/events_${MT.localDate(now)}_${MT.localTime(now).replace(/:/g, '')}.jsonl`,
      content,
      mime: 'application/x-ndjson',
    });
  }

  // ---------------------------------------------------------------------
  // Pętla główna i wiadomości
  // ---------------------------------------------------------------------
  function tick() {
    if (state.dead) {
      renderOverlay();
      return;
    }
    const now = Date.now();
    const inCallNow = !!qFirst(SELECTORS.leaveButton);
    if (inCallNow) state.lastInCallSeen = now;

    if (inCallNow && !state.inCall && !state.joining && !state.leaving) {
      onJoin();
      return;
    }
    if (state.inCall && !state.leaving) {
      if (!inCallNow && now - state.lastInCallSeen > TIMING.leaveGraceMs) {
        onLeave('call-ui-gone');
        return;
      }
      sendToPage('status');
      maybeSendChatNotice();
      const s = state.session;
      if (s && now - state.lastTitleAt > TIMING.titleMs) {
        state.lastTitleAt = now;
        const t = readTitle(s.code);
        if (t !== s.code && t !== s.title) {
          log(`nazwa spotkania: ${t}`);
          s.title = t;
          state.dirty = true;
        }
      }
      maybePersist();
    }
    renderOverlay();
    updateBadge();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'getStatus':
        sendResponse(getStatus());
        return false;
      case 'getSession':
        // Popup pobiera całą sesję tylko, gdy coś się zmieniło.
        sendResponse(state.session && state.session.updatedAt !== msg.since ? state.session : null);
        return false;
      case 'saveNow':
        saveNow('popup').then(sendResponse);
        return true;
      case 'dumpChat':
        dumpChat().then(sendResponse);
        return true;
      case 'downloadDebugLog':
        downloadDebugLog().then(sendResponse);
        return true;
      default:
        return false;
    }
  });

  document.addEventListener('protokolant:page', onPageEvent);
  window.addEventListener('message', onFrameMessage);

  chrome.storage.local.get(['debug', 'captionLanguage', 'chatNotice']).then((r) => {
    state.debug = !!r.debug;
    state.chatNotice = !!r.chatNotice;
    state.language = r.captionLanguage === undefined ? DEFAULT_LANGUAGE : r.captionLanguage;
    log(`wersja ${MT.VERSION}, język napisów: ${state.language || '(jak w Meet)'}${state.debug ? ', tryb debug' : ''}`);
    sendToPage('config', pageConfig());
    if (!hookInstalled()) warn('hook WebRTC nie jest zainstalowany – odśwież kartę (F5)');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.debug) state.debug = !!changes.debug.newValue;
    if (changes.captionLanguage) state.language = changes.captionLanguage.newValue || '';
    if (changes.chatNotice) state.chatNotice = !!changes.chatNotice.newValue;
    if (changes.debug || changes.captionLanguage) {
      sendToPage('config', pageConfig());
      // ponowny 'start' wysyła nowy język do Meet
      if (changes.captionLanguage && state.inCall) sendToPage('start', pageConfig());
    }
  });

  document.addEventListener('click', onDocumentClick, true);
  window.addEventListener('pagehide', () => {
    if (state.session) persist(true);
  });

  setInterval(tick, TIMING.tickMs);
  log(`załadowany na ${location.pathname}`);
})();
