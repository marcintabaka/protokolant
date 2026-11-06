// Test łączenia fragmentów wypowiedzi. Uruchom: node tests/format.test.js
require('../extension/common.js');
const MT = globalThis.Protokolant;
const assert = (c, m) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + m); if (!c) process.exitCode = 1; };
const t = Date.parse('2026-11-05T13:36:44');
const A = 'spaces/S/devices/a', B = 'spaces/S/devices/b';
const s = { devices: { [A]: 'Marcin Tabaka', [B]: 'Jan Kowalski' }, entries: [
  { ts: t, endTs: t + 6000, deviceId: A, text: 'no Dobra zaczynamy nowe spotkanie' },
  { ts: t + 7000, endTs: t + 12000, deviceId: A, text: 'coś wbudowanego w Google sprawdzę sobie teraz jak działa' },
  { ts: t + 13000, endTs: t + 18000, deviceId: A, text: 'sprawdzę sobie teraz jak działa podgląd na żywo' },
  { ts: t + 19000, endTs: t + 20000, deviceId: B, text: 'OK' },
  { ts: t + 21000, endTs: t + 22000, deviceId: A, text: 'to dalej' },
  { ts: t + 22000 + 21000, endTs: t + 50000, deviceId: A, text: 'po długiej przerwie' },
  { ts: t + 50000 + 19000, endTs: t + 72000, deviceId: A, text: 'po krótkiej przerwie' },
  { ts: t + 91000, marker: 'ponowne dołączenie do spotkania' },
  { ts: t + 92000, deviceId: A, text: 'po powrocie' },
  { ts: t + 93000, deviceId: A, text: 'tak tak' },
] };
const items = MT.formatEntries(s);
const lines = items.map((e) => e.marker ? `[${e.time}] -- ${e.marker}` : `[${e.time}] ${e.speaker}: ${e.text}`);
console.log(lines.join('\n'));
assert(items.length === 6, 'liczba linii po scaleniu: ' + items.length);
assert(items[0].text === 'no Dobra zaczynamy nowe spotkanie coś wbudowanego w Google sprawdzę sobie teraz jak działa podgląd na żywo', 'scalenie + usunięty powtórzony styk');
assert(items[1].speaker === 'Jan Kowalski' && items[2].text === 'to dalej', 'zmiana mówcy przerywa scalanie');
assert(items[3].text === 'po długiej przerwie po krótkiej przerwie', 'przerwa > 20 s zaczyna nową linię');
assert(items[5].text === 'po powrocie tak tak', 'po znaczniku nowa linia, potem scalanie');
assert(MT.joinFragments('tak tak', 'tak tak') === 'tak tak tak tak', 'krótkie powtórzenia (< 3 słów) zostają');
