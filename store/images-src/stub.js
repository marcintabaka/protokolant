// Atrapa API chrome.* dla popupu renderowanego poza przeglądarką z dodatkiem (zrzuty do sklepu).
// Scenariusz z adresu: popup.html?scenario=live|settings
(function () {
  const S = window.SAMPLE;
  const scenario = new URLSearchParams(location.search).get('scenario') || 'live';
  if (scenario === 'settings') {
    S.storage.chatNotice = true;
    S.status.notice = 'wysłane 10:00:10 (pole czatu w tle)';
  }
  window.chrome = {
    runtime: { getManifest: () => ({ version: '1.0' }), sendMessage: async () => ({ ok: true }) },
    tabs: {
      query: async () => [{ id: 1, url: `https://meet.google.com/${S.session.code}` }],
      sendMessage: async (_id, m) => {
        if (m.type === 'getStatus') return S.status;
        if (m.type === 'getSession') return m.since === S.session.updatedAt ? null : S.session;
        return { ok: true };
      },
    },
    storage: {
      local: {
        get: async (k) => {
          if (k === null) return S.storage;
          const out = {};
          for (const x of Array.isArray(k) ? k : [k]) if (x in S.storage) out[x] = S.storage[x];
          return out;
        },
        set: async () => {},
        remove: async () => {},
      },
    },
  };
})();
