/*
 * Service worker: zapis plików przez chrome.downloads, badge na ikonie,
 * zapis transkrypcji po zamknięciu karty, sprzątanie starych sesji.
 */
importScripts('common.js');

const MT = globalThis.Protokolant;
const TAG = '[Protokolant/sw]';

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function downloadText(filename, content, mime = 'text/plain') {
  const url = `data:${mime};charset=utf-8;base64,${toBase64Utf8(content)}`;
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'overwrite',
    saveAs: false,
  });
  console.log(TAG, 'pobrano', filename, 'id', downloadId);
  return { ok: true, filename, downloadId };
}

async function removePrevious(downloadId) {
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item && item.state === 'complete' && item.exists) await chrome.downloads.removeFile(downloadId);
  } catch (e) {
    console.warn(TAG, 'nie udało się usunąć poprzedniego pliku', e);
  }
  try {
    await chrome.downloads.erase({ id: downloadId });
  } catch (e) {
    /* wpis historii mógł już zniknąć */
  }
}

const ICONS = ['idle', 'rec', 'dim', 'warn'];

function setTabIcon(tabId, icon, badge) {
  const name = ICONS.includes(icon) ? icon : 'idle';
  const ignore = () => chrome.runtime.lastError; // karta mogła zostać zamknięta
  chrome.action.setIcon({ tabId, path: { 16: `icons/${name}-16.png`, 32: `icons/${name}-32.png` } }, ignore);
  chrome.action.setBadgeText({ tabId, text: badge || '' }, ignore);
  if (badge) chrome.action.setBadgeBackgroundColor({ tabId, color: '#E8590C' }, ignore);
}

async function getSession(key) {
  const k = MT.SESSION_PREFIX + key;
  return (await chrome.storage.local.get(k))[k] || null;
}

async function saveSession(key, reason, onlyIfChanged) {
  const s = await getSession(key);
  if (!s) return { ok: false, error: `Nie ma sesji ${key}` };
  const savedKey = MT.SAVED_PREFIX + key;
  const saved = (await chrome.storage.local.get(savedKey))[savedKey];
  if (onlyIfChanged && saved && saved.updatedAt >= (s.updatedAt || 0)) {
    return { ok: true, skipped: true, filename: saved.filename };
  }
  const filename = MT.sessionFilename(s);
  // Chrome ignoruje conflictAction 'overwrite' i tworzy kopie „-2”, „-3”,
  // więc najpierw usuwamy poprzedni plik tej samej sesji (po ID pobrania).
  if (saved && saved.downloadId != null) await removePrevious(saved.downloadId);
  const r = await downloadText(filename, MT.buildMarkdown(s), 'text/markdown');
  await chrome.storage.local.set({
    [savedKey]: { updatedAt: s.updatedAt || 0, at: Date.now(), filename, reason, downloadId: r.downloadId },
  });
  console.log(TAG, `zapisano sesję ${key} (${reason})`);
  prune().catch((e) => console.warn(TAG, 'prune', e));
  return r;
}

async function prune() {
  const all = await chrome.storage.local.get(null);
  const sessions = Object.keys(all)
    .filter((k) => k.startsWith(MT.SESSION_PREFIX))
    .map((k) => all[k])
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const old = sessions.slice(MT.MAX_SESSIONS);
  if (!old.length) return;
  const keys = old.flatMap((s) => [MT.SESSION_PREFIX + s.key, MT.SAVED_PREFIX + s.key]);
  await chrome.storage.local.remove(keys);
  console.log(TAG, 'usunięto stare sesje:', old.map((s) => s.key));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  const reply = (p) =>
    p.then(sendResponse, (e) => {
      console.warn(TAG, e);
      sendResponse({ ok: false, error: String(e) });
    });

  switch (msg && msg.type) {
    case 'saveSession':
      reply(saveSession(msg.key, msg.reason || 'manual', !!msg.onlyIfChanged));
      return true;
    case 'download':
      reply(downloadText(msg.filename, msg.content, msg.mime));
      return true;
    case 'register':
      if (tabId != null) chrome.storage.session.set({ [`tab:${tabId}`]: msg.key });
      return false;
    case 'icon':
      if (tabId != null) setTabIcon(tabId, msg.icon, msg.badge);
      return false;
    default:
      return false;
  }
});

// Zamknięcie karty ze spotkaniem: zapisujemy to, co jest w buforze
// (o ile nie zostało już zapisane po wyjściu z rozmowy).
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const k = `tab:${tabId}`;
  const key = (await chrome.storage.session.get(k))[k];
  if (!key) return;
  await chrome.storage.session.remove(k);
  try {
    const r = await saveSession(key, 'tab-closed', true);
    console.log(TAG, 'zamknięto kartę', tabId, r);
  } catch (e) {
    console.warn(TAG, 'zapis po zamknięciu karty nie powiódł się', e);
  }
});
