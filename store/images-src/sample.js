// Fikcyjne spotkanie do zrzutów ekranu w Chrome Web Store (bez prawdziwych danych).
(function (g) {
  const t = (h, m, s) => new Date(2026, 10, 5, h, m, s).getTime();
  const A = 'spaces/demo/devices/anna';
  const P = 'spaces/demo/devices/piotr';
  const K = 'spaces/demo/devices/kasia';
  const devices = { [A]: 'Anna Nowak', [P]: 'Piotr Wiśniewski', [K]: 'Katarzyna Zielińska' };
  const e = (id, ts, endTs, deviceId, text, chat) => ({ id, mid: `${id}/${deviceId}`, ts, endTs, deviceId, text, version: 3, ...(chat ? { chat: true } : {}) });
  const entries = [
    e(1, t(10, 0, 5), t(10, 0, 12), A, 'dzień dobry wszystkim zaczynamy od przeglądu zadań z poprzedniego sprintu'),
    e(2, t(10, 0, 13), t(10, 0, 19), A, 'Piotrze jak wygląda integracja z płatnościami'),
    e(3, t(10, 0, 21), t(10, 0, 38), P, 'integracja jest prawie gotowa zostały testy na środowisku testowym myślę że do czwartku zamkniemy temat'),
    e(4, t(10, 0, 40), t(10, 0, 51), K, 'dorzucę że klient prosił o dodatkowy raport miesięczny więc warto uwzględnić go w planie'),
    e(5, t(10, 0, 52), t(10, 0, 52), A, 'https://example.com/raport-wymagania', true),
    e(6, t(10, 1, 3), t(10, 1, 14), A, 'dobrze dopisuję raport jako osobne zadanie Kasiu przygotujesz krótką specyfikację do piątku'),
    e(7, t(10, 1, 15), t(10, 1, 20), K, 'tak jasne prześlę ją na czacie'),
    e(8, t(10, 1, 22), t(10, 1, 33), P, 'jeszcze jedna rzecz potrzebujemy decyzji w sprawie nowego dostawcy serwerów'),
    e(9, t(10, 1, 35), t(10, 1, 47), A, 'zróbmy krótkie porównanie ofert i wróćmy do tego w środę na spotkaniu zespołu'),
  ];
  const session = {
    key: 'kpt-wzrd-mnq_2026-11-05',
    code: 'kpt-wzrd-mnq',
    title: 'Planowanie sprintu – zespół produktu',
    startedAt: t(10, 0, 2),
    endedAt: t(10, 31, 40),
    updatedAt: t(10, 1, 47),
    selfDevice: A,
    devices,
    entries,
  };
  const older = [
    { key: 'qwe-rtyu-iop_2026-11-04', code: 'qwe-rtyu-iop', title: 'Spotkanie z klientem – wdrożenie', startedAt: t(14, 0, 0) - 86400000, updatedAt: t(14, 45, 0) - 86400000, devices, entries: entries.slice(0, 6) },
    { key: 'zxc-vbnm-asd_2026-11-03', code: 'zxc-vbnm-asd', title: 'Daily – zespół produktu', startedAt: t(9, 30, 0) - 2 * 86400000, updatedAt: t(9, 45, 0) - 2 * 86400000, devices, entries: entries.slice(0, 4) },
  ];
  const storage = { captionLanguage: 'pl-PL', debug: false, chatNotice: false };
  for (const s of [session, ...older]) {
    storage[`session:${s.key}`] = s;
    storage[`saved:${s.key}`] = { updatedAt: s === session ? 0 : s.updatedAt, filename: 'x.md' };
  }
  const status = {
    version: '1.0',
    inCall: true,
    code: session.code,
    title: session.title,
    key: session.key,
    updatedAt: session.updatedAt,
    entries: 7,
    chats: 1,
    level: 'on',
    language: 'pl-PL',
    rtc: null,
    devices: 3,
    selfName: 'Anna Nowak',
    debug: false,
    debugEvents: 0,
    notice: null,
  };
  g.SAMPLE = { session, storage, status };
})(globalThis);
