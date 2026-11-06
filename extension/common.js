/*
 * Wspólny kod: content script, service worker (importScripts) i popup.
 * Wystawia globalny obiekt Protokolant.
 */
(function (g) {
  'use strict';

  // Jedyne źródło wersji to manifest.json (w Node, w testach: 'dev').
  const VERSION = g.chrome && g.chrome.runtime && g.chrome.runtime.getManifest ? g.chrome.runtime.getManifest().version : 'dev';
  const DOWNLOAD_DIR = 'Protokolant';
  const SESSION_PREFIX = 'session:';
  const SAVED_PREFIX = 'saved:';
  const MAX_SESSIONS = 30;

  const pad = (n, w = 2) => String(n).padStart(w, '0');

  function localDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function localTime(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function hhmm(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  const PL_MAP = { ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z' };

  function slugify(s) {
    const slug = String(s || '')
      .toLowerCase()
      .replace(/[ąćęłńóśźż]/g, (c) => PL_MAP[c])
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '');
    return slug || 'spotkanie';
  }

  // Nazwa mówcy: z mapy urządzeń uczestników, potem z wpisu, na końcu skrót ID urządzenia.
  function entrySpeaker(e, s) {
    const name = (e.deviceId && s.devices && s.devices[e.deviceId]) || e.speaker;
    if (name) return name;
    const tail = String(e.deviceId || '').split('/').pop();
    return tail ? `Uczestnik ${tail.slice(-4)}` : 'Nieznany';
  }

  function sessionEnd(s) {
    return s.endedAt || s.updatedAt || null;
  }

  // Nazwa pliku z kodem spotkania: stała, niezależna od tego, kiedy Meet poda nazwę spotkania.
  function sessionFilename(s) {
    return `${DOWNLOAD_DIR}/${localDate(s.startedAt)}_${hhmm(s.startedAt)}_${slugify(s.code)}.md`;
  }

  function sessionTitle(s) {
    return s.title && s.title !== s.code ? s.title : `Spotkanie ${s.code}`;
  }

  function uniq(arr) {
    return [...new Set(arr.filter(Boolean))];
  }

  // Kolejne fragmenty tej samej osoby łączymy w jedną wypowiedź, jeśli przerwa
  // między końcem poprzedniego a początkiem następnego nie przekracza tej wartości.
  const MERGE_GAP_MS = 20000;

  const wordKey = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  // Meet tnie mowę na fragmenty i nowy fragment bywa początkiem powtórzonym z końca
  // poprzedniego („…jak działa” + „jak działa podgląd…”). Usuwamy taki styk (≥ 3 słowa).
  function joinFragments(prev, next) {
    const pw = prev.split(/\s+/).filter(Boolean);
    const nw = next.split(/\s+/).filter(Boolean);
    const pk = pw.map(wordKey);
    const nk = nw.map(wordKey);
    for (let k = Math.min(pw.length, nw.length, 12); k >= 3; k--) {
      let same = true;
      for (let i = 0; i < k; i++) {
        if (pk[pk.length - k + i] !== nk[i]) {
          same = false;
          break;
        }
      }
      if (same) return [...pw, ...nw.slice(k)].join(' ');
    }
    return `${prev} ${next}`;
  }

  // Wpisy w postaci, w jakiej trafiają do pliku (używane też przez podgląd w popupie).
  function formatEntries(s) {
    const out = [];
    let last = null; // ostatnia wypowiedź w out + czas końca jej ostatniego fragmentu
    for (const e of s.entries || []) {
      if (e.marker) {
        out.push({ time: localTime(e.ts), marker: e.marker });
        last = null;
        continue;
      }
      const text = (e.text || '').trim();
      if (!text) continue;
      const speaker = entrySpeaker(e, s);
      if (e.chat) {
        // wiadomości z czatu nie łączymy z mową i przerywają scalanie
        out.push({ time: localTime(e.ts), speaker, text, chat: true });
        last = null;
        continue;
      }
      if (last && last.item.speaker === speaker && e.ts - last.endTs <= MERGE_GAP_MS) {
        last.item.text = joinFragments(last.item.text, text);
        last.endTs = Math.max(last.endTs, e.endTs || e.ts);
        continue;
      }
      const item = { time: localTime(e.ts), speaker, text };
      out.push(item);
      last = { item, endTs: e.endTs || e.ts };
    }
    return out;
  }

  function buildMarkdown(s) {
    const items = formatEntries(s);
    const utterances = items.filter((e) => !e.marker && !e.chat);
    const chats = items.filter((e) => e.chat);
    const speakers = uniq(utterances.map((e) => e.speaker));
    const participants = uniq([...Object.values(s.devices || {}), ...(s.participants || [])]);
    const end = sessionEnd(s);
    const endStr = end
      ? localDate(end) === localDate(s.startedAt)
        ? localTime(end)
        : `${localDate(end)} ${localTime(end)}`
      : '—';

    const lines = [];
    lines.push(`# ${sessionTitle(s)}`, '');
    lines.push(`- **Kod spotkania:** ${s.code}`);
    lines.push(`- **Link:** https://meet.google.com/${s.code}`);
    lines.push(`- **Data:** ${localDate(s.startedAt)}`);
    lines.push(`- **Początek:** ${localTime(s.startedAt)}`);
    lines.push(`- **Koniec:** ${endStr}`);
    lines.push(`- **Mówcy:** ${speakers.length ? speakers.join(', ') : '—'}`);
    if (participants.length) lines.push(`- **Uczestnicy:** ${participants.join(', ')}`);
    lines.push(`- **Liczba wypowiedzi:** ${utterances.length}`);
    if (chats.length) lines.push(`- **Wiadomości na czacie:** ${chats.length}`);
    lines.push(`- **Źródło:** napisy Google Meet (kanał WebRTC), Protokolant ${VERSION}`);
    lines.push('', '---', '');

    for (const e of items) {
      if (e.marker) lines.push(`[${e.time}] _— ${e.marker} —_`, '');
      else if (e.chat) lines.push(`[${e.time}] ${e.speaker} (czat): ${e.text}`, '');
      else lines.push(`[${e.time}] ${e.speaker}: ${e.text}`, '');
    }
    return lines.join('\n');
  }

  g.Protokolant = {
    VERSION,
    DOWNLOAD_DIR,
    SESSION_PREFIX,
    SAVED_PREFIX,
    MAX_SESSIONS,
    pad,
    localDate,
    localTime,
    hhmm,
    slugify,
    entrySpeaker,
    sessionEnd,
    sessionFilename,
    sessionTitle,
    formatEntries,
    joinFragments,
    MERGE_GAP_MS,
    buildMarkdown,
  };
})(globalThis);
