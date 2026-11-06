// Symulacja chat-frame.js w ramce Google Chat osadzonej w Meet. Uruchom: node tests/chat-frame.sim.js
const posted = []; const winL = {};
globalThis.window = globalThis;
globalThis.top = { postMessage: (d, o) => posted.push([d, o]) };
globalThis.location = { href: 'https://chat.google.com/frame', origin: 'https://chat.google.com', ancestorOrigins: ['https://meet.google.com'] };
globalThis.addEventListener = (t, f) => (winL[t] = winL[t] || []).push(f);
globalThis.fetch = async () => ({ ok: true });
globalThis.XMLHttpRequest = class { open() {} send() {} addEventListener() {} };
globalThis.InputEvent = class { constructor(t) { this.type = t; } };
globalThis.KeyboardEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
globalThis.HTMLTextAreaElement = class {};
// pole wiadomości (contenteditable): Enter wysyła żądanie create_topic jak prawdziwy czat
const box = { textContent: '', focus() {}, dispatchEvent(e) { if (e.type === 'keydown' && e.key === 'Enter') { const t = this.textContent; this.textContent = ''; fetch('/u/0/api/create_topic', { method: 'POST', body: JSON.stringify([null, t]) }); } } };
globalThis.document = {
  documentElement: { cloneNode: () => ({ querySelectorAll: () => [], outerHTML: '<html>czat</html>' }) },
  querySelector: (sel) => (sel.includes('textbox') ? box : null),
  execCommand: (cmd, _ui, text) => { if (cmd === 'insertText') box.textContent += text; return true; },
};
require('../extension/chat-frame.js');
const assert = (c, m) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + m); if (!c) process.exitCode = 1; };
(async () => {
  await fetch('/u/0/api/create_topic?c=1', { method: 'POST', body: JSON.stringify([null, 'https://example.com link', []]) });
  await fetch('/u/0/api/list_topics', { method: 'POST', body: '[]' });
  await new Promise((r) => setTimeout(r, 10));
  assert(posted.length === 1 && posted[0][0].type === 'own-message' && posted[0][0].text === 'https://example.com link' && posted[0][1] === 'https://meet.google.com', 'własna wiadomość przekazana do Meet');
  winL.message.forEach((f) => f({ origin: 'https://meet.google.com', data: { source: 'protokolant', type: 'dump-chat' } }));
  const dump = posted.find((p) => p[0].type === 'dump');
  assert(dump && dump[0].html.includes('czat') && dump[0].requests.length === 2, 'zrzut ramki z listą żądań: ' + (dump && dump[0].requests.join(' | ')));
  winL.message.forEach((f) => f({ origin: 'https://meet.google.com', data: { source: 'protokolant', type: 'send-notice', text: 'ℹ️ transkrypcja' } }));
  await new Promise((r) => setTimeout(r, 600));
  const res = posted.find((p) => p[0].type === 'notice-result');
  assert(res && res[0].ok === true, 'powiadomienie wpisane i wysłane: ' + JSON.stringify(res && res[0]));
  assert(posted.some((p) => p[0].type === 'own-message' && p[0].text === 'ℹ️ transkrypcja'), 'powiadomienie trafia też jako własna wiadomość');
  box.textContent = 'szkic użytkownika';
  winL.message.forEach((f) => f({ origin: 'https://meet.google.com', data: { source: 'protokolant', type: 'send-notice', text: 'ℹ️ transkrypcja' } }));
  await new Promise((r) => setTimeout(r, 300));
  const res2 = posted.filter((p) => p[0].type === 'notice-result')[1];
  assert(res2 && res2[0].ok === false && box.textContent === 'szkic użytkownika', 'nie nadpisuje szkicu wpisanego przez użytkownika');
})();
