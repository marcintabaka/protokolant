'use strict';

const MT = globalThis.Protokolant;
const $ = (id) => document.getElementById(id);
let meetTab = null;
let liveKey = null; // klucz sesji w aktywnej karcie Meet
let liveInCall = false; // czy w aktywnej karcie trwa rozmowa
let view = { key: null, live: false, updatedAt: null }; // co pokazuje podgląd

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function msg(text, cls = '') {
  $('msg').className = cls;
  $('msg').textContent = text;
}

async function activeMeetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.url && tab.url.startsWith('https://meet.google.com/') ? tab : null;
}

async function sendTab(m) {
  if (!meetTab) return { ok: false, error: 'Aktywna karta to nie Google Meet.' };
  try {
    return await chrome.tabs.sendMessage(meetTab.id, m);
  } catch (e) {
    return { ok: false, error: 'no-content-script' };
  }
}

const LEVEL_TEXT = {
  on: ['ok', '✔ kanał napisów otwarty, przechwytuję'],
  connecting: ['warn', '… łączę z kanałem napisów'],
  ending: ['muted', '■ kończenie rozmowy – zapisuję plik'],
  'no-hook': ['bad', '✖ brak hooka WebRTC – odśwież kartę Meet (F5)'],
  'no-channel': ['bad', '✖ brak kanału napisów – transkrypcja NIE jest zapisywana'],
  undecodable: ['bad', '✖ pakiety przychodzą, ale nie umiem ich odczytać – wyślij log debug'],
};

// ---------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------
async function renderStatus() {
  const box = $('status');
  if (!meetTab) {
    box.innerHTML = `<b>Jak to działa</b>
      <ol class="help">
        <li>Dołącz do spotkania w Google Meet – transkrypcja zaczyna się sama (nie trzeba włączać napisów).</li>
        <li>W trakcie rozmowy kliknij tę ikonę, żeby zobaczyć podgląd transkrypcji na żywo.</li>
        <li>Po wyjściu ze spotkania plik Markdown zapisze się w folderze <b>Pobrane/${esc(MT.DOWNLOAD_DIR)}</b>.</li>
      </ol>`;
    $('save').disabled = $('dlog').disabled = $('dchat').disabled = true;
    return null;
  }
  const st = await sendTab({ type: 'getStatus' });
  if (!st || st.error) {
    box.innerHTML =
      '<span class="bad">Dodatek nie działa w tej karcie.</span><br>' +
      '<span class="muted">Odśwież kartę Meet (F5) – karty otwarte przed instalacją albo przeładowaniem dodatku nie mają skryptu.</span>';
    $('save').disabled = $('dlog').disabled = $('dchat').disabled = true;
    return null;
  }
  if (st.dead) {
    box.innerHTML = '<span class="bad">Dodatek został przeładowany – odśwież kartę Meet (F5).</span>';
    $('save').disabled = $('dlog').disabled = $('dchat').disabled = true;
    return null;
  }
  $('save').disabled = !st.key;
  $('dlog').disabled = $('dchat').disabled = false;
  const [cls, text] = LEVEL_TEXT[st.level] || ['muted', '?'];
  const r = st.rtc;
  let diag = 'brak statusu z hooka WebRTC';
  if (r) {
    const chans = (r.channels || [])
      .filter((c) => c.current)
      .map((c) => `${c.label}(${c.origin}):${c.state}`)
      .join(', ');
    const c = r.counts || {};
    const cnt = (x) => (x ? `${x.caption}/${x.raw}` : '0/0');
    diag =
      `połączenie: ${r.mainPc ? esc(r.pcState) : 'brak'} · kanały: ${esc(chans || '—')}<br>` +
      `pakiety v2: ${cnt(c.captions_v2)} · legacy: ${cnt(c.captions)} · media-session: ${esc(r.mediaSession || '—')} · ` +
      `uczestnicy: ${st.devices}${st.selfName ? ` · Ty: ${esc(st.selfName)}` : ''}` +
      (r.errors && r.errors.length ? `<br><span class="bad">błędy: ${esc(r.errors.join(' | '))}</span>` : '');
  }
  box.innerHTML = `
    <div class="row"><b>Spotkanie</b><span>${esc(st.title && st.title !== st.code ? st.title : '(bez nazwy)')} <span class="muted">${esc(st.code)}</span></span></div>
    <div class="row"><b>Rozmowa</b><span>${st.inCall ? `<span class="${cls}">${text}</span>` : '<span class="muted">poza rozmową (lobby lub po wyjściu)</span>'}</span></div>
    <div class="row"><b>Wypowiedzi</b><span>${st.entries}${st.chats ? ` · czat: ${st.chats}` : ''}</span></div>
    ${st.notice ? `<div class="row"><b>Powiadomienie</b><span class="${/^błąd/.test(st.notice) ? 'warn' : 'muted'}">${esc(st.notice)}</span></div>` : ''}
`;
  $('diag-info').innerHTML = `${diag}${st.debug ? ` · debug: ${st.debugEvents} zdarzeń` : ''}`;
  return st;
}

// ---------------------------------------------------------------------
// Podgląd transkrypcji
// ---------------------------------------------------------------------
function renderTranscript(s, live) {
  const pane = $('transcript');
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 30;
  const items = MT.formatEntries(s);
  const nChat = items.filter((e) => e.chat).length;
  $('tr-title').textContent = `Transkrypcja${live ? ' (na żywo)' : ''} – ${MT.sessionTitle(s)}, ${items.filter((e) => !e.marker && !e.chat).length} wypowiedzi${nChat ? `, ${nChat} na czacie` : ''}`;
  pane.innerHTML = items.length
    ? items
        .map((e) =>
          e.marker
            ? `<p><span class="t">[${e.time}]</span><span class="m">— ${esc(e.marker)} —</span></p>`
            : `<p${e.chat ? ' class="chat"' : ''}><span class="t">[${e.time}]</span><span class="s">${esc(e.speaker)}${e.chat ? ' (czat)' : ''}:</span> ${esc(e.text)}</p>`
        )
        .join('')
    : '<span class="muted">Jeszcze nikt nic nie powiedział.</span>';
  if (atBottom || view.updatedAt === null) pane.scrollTop = pane.scrollHeight;
  view.updatedAt = s.updatedAt;
}

async function refreshTranscript() {
  if (view.live) {
    const s = await sendTab({ type: 'getSession', since: view.updatedAt });
    if (s && s.entries) renderTranscript(s, true);
  } else if (view.key) {
    const k = MT.SESSION_PREFIX + view.key;
    const s = (await chrome.storage.local.get(k))[k];
    if (s && s.updatedAt !== view.updatedAt) renderTranscript(s, false);
  }
  $('tr-live').hidden = !(liveKey && !view.live);
}

function showLive() {
  view = { key: liveKey, live: true, updatedAt: null };
  refreshTranscript();
  renderSessions();
}

function showStored(key) {
  view = { key, live: key === liveKey, updatedAt: null };
  refreshTranscript();
  renderSessions();
}

// ---------------------------------------------------------------------
// Lista sesji w buforze
// ---------------------------------------------------------------------
async function renderSessions() {
  const all = await chrome.storage.local.get(null);
  const sessions = Object.keys(all)
    .filter((k) => k.startsWith(MT.SESSION_PREFIX))
    .map((k) => all[k])
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 10);
  const ul = $('sessions');
  $('rm-all').hidden = !sessions.length;
  if (!sessions.length) {
    ul.innerHTML = '<li class="muted">Brak zapisanych transkrypcji.</li>';
    return;
  }
  ul.innerHTML = sessions
    .map((s) => {
      const saved = all[MT.SAVED_PREFIX + s.key];
      const n = MT.formatEntries(s).filter((e) => !e.marker && !e.chat).length;
      const savedInfo = s.key === liveKey && liveInCall
        ? 'trwa spotkanie'
        : saved
        ? saved.updatedAt >= (s.updatedAt || 0)
          ? 'plik aktualny'
          : '<span class="warn">są niezapisane zmiany</span>'
        : '<span class="warn">jeszcze nie zapisano pliku</span>';
      return `<li class="${s.key === view.key ? 'active' : ''}">
        <div class="t" data-show="${esc(s.key)}" title="Pokaż transkrypcję">
          <div data-show="${esc(s.key)}">${esc(MT.sessionTitle(s))}</div>
          <div class="muted" data-show="${esc(s.key)}">${MT.localDate(s.startedAt)} ${MT.localTime(s.startedAt).slice(0, 5)} · ${n} wypowiedzi · ${savedInfo}</div>
        </div>
        <button data-dl="${esc(s.key)}">Pobierz</button>
        <button data-rm="${esc(s.key)}" title="Usuń z bufora">✕</button>
      </li>`;
    })
    .join('');
}

$('sessions').addEventListener('click', async (e) => {
  const show = e.target.getAttribute('data-show');
  const dl = e.target.getAttribute('data-dl');
  const rm = e.target.getAttribute('data-rm');
  if (show) showStored(show);
  if (dl) {
    const r = await chrome.runtime.sendMessage({ type: 'saveSession', key: dl, reason: 'popup-list' });
    if (r && r.ok) msg(`Zapisano: Pobrane/${r.filename}`, 'ok');
    else msg(`Błąd: ${r && r.error}`, 'bad');
    renderSessions();
  }
  if (rm && confirm('Usunąć tę transkrypcję z bufora dodatku? (Pobrane pliki zostają.)')) {
    await chrome.storage.local.remove([MT.SESSION_PREFIX + rm, MT.SAVED_PREFIX + rm]);
    if (view.key === rm) view = { key: null, live: false, updatedAt: null };
    renderSessions();
  }
});

$('tr-live').addEventListener('click', showLive);

$('save').addEventListener('click', async () => {
  const r = await sendTab({ type: 'saveNow' });
  if (r && r.ok) msg(r.skipped ? 'Bez zmian od ostatniego zapisu.' : `Zapisano: Pobrane/${r.filename}`, 'ok');
  else msg(`Błąd: ${r && r.error}`, 'bad');
  renderSessions();
});

$('dlog').addEventListener('click', async () => {
  const r = await sendTab({ type: 'downloadDebugLog' });
  if (r && r.ok) msg(`Log: Pobrane/${r.filename}`, 'ok');
  else msg(`Błąd: ${r && r.error}`, 'bad');
});

$('dchat').addEventListener('click', async () => {
  const r = await sendTab({ type: 'dumpChat' });
  if (r && r.ok) msg(`Zrzut czatu: Pobrane/${r.filename}`, 'ok');
  else msg(`Błąd: ${r && r.error}`, 'bad');
});

function showDebugTools(on) {
  $('dlog').hidden = $('dchat').hidden = !on;
}

$('rm-all').addEventListener('click', async () => {
  if (!confirm('Usunąć wszystkie transkrypcje z bufora dodatku? Pobrane pliki zostają na dysku.')) return;
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(MT.SESSION_PREFIX) || k.startsWith(MT.SAVED_PREFIX));
  await chrome.storage.local.remove(keys);
  view = { key: null, live: false, updatedAt: null };
  $('transcript').innerHTML = '<span class="muted">Brak transkrypcji do pokazania.</span>';
  $('tr-title').textContent = 'Transkrypcja';
  msg(`Usunięto ${keys.filter((k) => k.startsWith(MT.SESSION_PREFIX)).length} transkrypcji z bufora.`, 'ok');
  renderSessions();
});

$('chatNotice').addEventListener('change', (e) => chrome.storage.local.set({ chatNotice: e.target.checked }));

$('debug').addEventListener('change', (e) => {
  chrome.storage.local.set({ debug: e.target.checked });
  showDebugTools(e.target.checked);
});
$('language').addEventListener('change', (e) => chrome.storage.local.set({ captionLanguage: e.target.value }));

async function tick() {
  const st = await renderStatus();
  const wasInCall = liveInCall;
  liveInCall = !!(st && st.inCall);
  if (wasInCall !== liveInCall) renderSessions();
  const key = st && st.key ? st.key : null;
  if (key !== liveKey) {
    liveKey = key;
    // Domyślnie pokazujemy bieżącą rozmowę, jeśli użytkownik nie wybrał innej.
    if (liveKey && (!view.key || view.live)) showLive();
  }
  await refreshTranscript();
}

(async function init() {
  $('ver').textContent = MT.VERSION;
  const cfg = await chrome.storage.local.get(['debug', 'captionLanguage', 'chatNotice']);
  $('debug').checked = !!cfg.debug;
  $('chatNotice').checked = !!cfg.chatNotice;
  $('diag').open = !!cfg.debug;
  showDebugTools(!!cfg.debug);
  $('language').value = cfg.captionLanguage === undefined ? 'pl-PL' : cfg.captionLanguage;
  meetTab = await activeMeetTab();
  await renderSessions();
  await tick();
  // Bez rozmowy w aktywnej karcie pokaż najnowszą transkrypcję z bufora.
  if (!view.key) {
    const first = document.querySelector('#sessions [data-show]');
    if (first) showStored(first.getAttribute('data-show'));
  }
  setInterval(tick, 2000);
})();
