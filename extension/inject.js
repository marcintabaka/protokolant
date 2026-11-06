/*
 * Skrypt w świecie strony (content script z "world": "MAIN", document_start).
 *
 * Podpina się pod RTCPeerConnection Meet i otwiera własne kanały danych
 * "captions" i "captions_v2", którymi serwer Meet wysyła napisy (niezależnie
 * od tego, czy napisy są włączone w interfejsie). Nazwy uczestników bierze
 * z kanału "collections" i z odpowiedzi SyncMeetingSpaceCollections.
 * Język napisów ustawia pakietem na kanale "media-session".
 *
 * Komunikacja z content scriptem (świat izolowany) przez zdarzenia DOM
 * z JSON-em w detail:
 *   strona → CS:  'protokolant:page'  {type: 'caption'|'device'|'self'|'status'|'raw'|'log', ...}
 *   CS → strona:  'protokolant:cs'    {type: 'start'|'stop'|'config', ...}
 */
(() => {
  'use strict';
  if (window.__protokolantHook) return;
  window.__protokolantHook = true;

  const P = globalThis.ProtokolantProto;
  const TAG = '[Protokolant/page]';
  const CAPTION_LABELS = ['captions', 'captions_v2'];
  const URLS = {
    sync: 'https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingSpaceService/SyncMeetingSpaceCollections',
    createDevice: 'https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingDeviceService/CreateMeetingDevice',
    createMessage: 'https://meet.google.com/$rpc/google.rtc.meetings.v1.MeetingMessageService/CreateMeetingMessage',
  };

  const S = {
    started: false,
    language: null,
    debug: false,
    mainPc: null,
    own: new WeakSet(), // kanały otwarte przez nas
    attached: new WeakSet(),
    meetCreatedV2: new WeakSet(), // PC, na których Meet sam otworzył captions_v2
    ownByPc: new WeakMap(), // pc -> {label: channel}
    channels: [], // do statusu
    counts: { captions: { raw: 0, caption: 0, control: 0, rejected: 0 }, captions_v2: { raw: 0, caption: 0, control: 0, rejected: 0 } },
    lastPacketAt: 0,
    mediaSession: null,
    lastOp: 0,
    lastSeq: 0,
    langSentAt: 0,
    nextChannelId: 52000,
    devices: {},
    selfDevice: null,
    errors: [],
    v2Active: false,
    chatCount: 0,
  };

  function emit(type, data) {
    try {
      document.dispatchEvent(new CustomEvent('protokolant:page', { detail: JSON.stringify({ type, ...data }) }));
    } catch (e) {
      console.warn(TAG, 'emit', e);
    }
  }
  const log = (...a) => {
    console.log(TAG, ...a);
  };
  function err(where, e) {
    const m = `${where}: ${e && e.message ? e.message : e}`;
    S.errors.push(m);
    if (S.errors.length > 20) S.errors.shift();
    console.warn(TAG, m);
  }

  // ------------------------------------------------------------------
  // Deduplikacja między kanałami: ten sam mówca,
  // wersja i tekst w ciągu 700 ms = ta sama wypowiedź pod innym ID.
  // ------------------------------------------------------------------
  const recentByContent = new Map();
  const alias = new Map();
  function canonicalId(m, now) {
    const a = alias.get(m.mid);
    if (a && now - a.at <= 30000) {
      a.at = now;
      return a.mid;
    }
    const key = `${m.deviceId}|${m.version}|${m.text}`;
    const r = recentByContent.get(key);
    if (r && now - r.at <= 700) {
      if (r.mid !== m.mid) {
        alias.set(m.mid, { mid: r.mid, at: now });
        emit('alias', { from: m.mid, to: r.mid });
      }
      return r.mid;
    }
    recentByContent.set(key, { mid: m.mid, at: now });
    if (recentByContent.size > 512) {
      for (const [k, v] of recentByContent) if (now - v.at > 700) recentByContent.delete(k);
    }
    if (alias.size > 512) {
      for (const [k, v] of alias) if (now - v.at > 30000) alias.delete(k);
    }
    return m.mid;
  }

  // ------------------------------------------------------------------
  // Dane binarne z kanałów
  // ------------------------------------------------------------------
  async function toBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (typeof data === 'string') return new TextEncoder().encode(data);
    return new Uint8Array(0);
  }

  function rawDebug(label, bytes, note) {
    if (!S.debug) return;
    const hex = Array.from(bytes.subarray(0, 160), (b) => b.toString(16).padStart(2, '0')).join('');
    emit('raw', { label, note, len: bytes.length, skeleton: P.skeleton(bytes).slice(0, 300), hex });
  }

  function handleCaptionBytes(ch, label, bytes) {
    const c = S.counts[label];
    c.raw++;
    S.lastPacketAt = Date.now();
    let r;
    try {
      r = label === 'captions_v2' ? P.decodeCaptionV2(bytes) : P.decodeCaptionLegacy(bytes);
    } catch (e) {
      r = { rejected: 'decode-threw' };
    }
    if (r.control) {
      c.control++;
      rawDebug(label, bytes, 'control');
      return;
    }
    if (r.rejected) {
      c.rejected++;
      rawDebug(label, bytes, `rejected:${r.rejected}`);
      return;
    }
    c.caption++;
    if (label === 'captions_v2' && S.own.has(ch)) {
      try {
        ch.send(P.encodeCaptionV2Ack(r.id, r.version));
      } catch (e) {
        /* kanał mógł się zamknąć */
      }
    }
    // Gdy działa captions_v2, kanał legacy tylko by dublował wypowiedzi.
    if (label === 'captions_v2') S.v2Active = true;
    else if (S.v2Active) {
      c.skipped = (c.skipped || 0) + 1;
      return;
    }
    const now = Date.now();
    const m = { mid: `${r.id}/${r.deviceId}`, deviceId: r.deviceId, version: Number(r.version), text: r.text, lang: r.lang, ch: label };
    m.mid = canonicalId(m, now);
    if (S.debug) emit('raw', { label, note: 'caption', mid: m.mid, version: m.version, text: m.text });
    emit('caption', m);
  }

  function attachCaptions(ch, pc, origin) {
    if (S.attached.has(ch)) return;
    S.attached.add(ch);
    const label = ch.label;
    S.channels.push({ ch, label, origin, pc });
    if (S.channels.length > 20) S.channels.shift();
    let chain = Promise.resolve();
    ch.addEventListener('message', (ev) => {
      chain = chain
        .then(async () => {
          let bytes = await toBytes(ev.data);
          if (label === 'captions') bytes = await P.maybeGunzip(bytes);
          handleCaptionBytes(ch, label, bytes);
        })
        .catch((e) => err(`message ${label}`, e));
    });
    if (S.own.has(ch)) {
      ch.addEventListener('open', () => {
        log(`kanał ${label} otwarty`);
        if (label === 'captions_v2' || label === 'captions') maybeSendLanguage();
        emitStatus();
      });
      ch.addEventListener('close', () => {
        log(`kanał ${label} zamknięty`);
        emitStatus();
        setTimeout(() => reopenIfNeeded(pc, label), 1000);
      });
    }
    log(`podpięto kanał ${label} (${origin})`);
  }

  function reopenIfNeeded(pc, label) {
    if (!S.started) return;
    if (pc.connectionState === 'closed' || pc.connectionState === 'failed') return;
    const cur = (S.ownByPc.get(pc) || {})[label];
    if (cur && (cur.readyState === 'open' || cur.readyState === 'connecting')) return;
    log(`ponownie otwieram kanał ${label}`);
    openChannels(pc);
  }

  // ------------------------------------------------------------------
  // Otwieranie kanałów napisów i ustawianie języka
  // ------------------------------------------------------------------
  let nativeCreate = null;
  let nativeSend = null;

  function openChannels(pc) {
    if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') return;
    const mine = S.ownByPc.get(pc) || {};
    S.ownByPc.set(pc, mine);
    for (const label of CAPTION_LABELS) {
      if (label === 'captions_v2' && S.meetCreatedV2.has(pc)) continue;
      const cur = mine[label];
      if (cur && (cur.readyState === 'open' || cur.readyState === 'connecting')) continue;
      let ch;
      const opts = { ordered: true, maxRetransmits: 10 };
      try {
        ch = nativeCreate.call(pc, label, { ...opts, id: ++S.nextChannelId });
      } catch (e) {
        try {
          ch = nativeCreate.call(pc, label, opts);
        } catch (e2) {
          err(`createDataChannel ${label}`, e2);
          continue;
        }
      }
      ch.binaryType = 'arraybuffer';
      S.own.add(ch);
      mine[label] = ch;
      attachCaptions(ch, pc, 'own');
    }
    emitStatus();
  }

  function trackMediaSessionSend(data) {
    let bytes = null;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (!bytes) return;
    const op = P.mediaSessionOp(bytes);
    if (op != null) S.lastOp = op;
    const seq = P.mediaSessionAckSeq(bytes);
    if (seq != null) S.lastSeq = seq;
  }

  function maybeSendLanguage() {
    const code = S.language;
    if (!S.started || !code) return;
    const ms = S.mediaSession;
    if (!ms || ms.readyState !== 'open') return;
    const now = Date.now();
    if (now - S.langSentAt < 2000) return;
    S.langSentAt = now;
    try {
      const packets = [P.encodeCaptionLanguage(S.lastOp + 1, code), P.encodeMediaSessionAck(S.lastSeq + 1), P.encodeMediaSessionAck(S.lastSeq + 2)];
      for (const p of packets) {
        nativeSend.call(ms, p);
        trackMediaSessionSend(p);
      }
      log(`ustawiono język napisów: ${code}`);
    } catch (e) {
      err('sendLanguage', e);
    }
  }

  function setMainPc(pc) {
    if (S.mainPc === pc) return;
    S.mainPc = pc;
    S.v2Active = false;
    log('znaleziono główne połączenie Meet (kanał collections)');
    if (S.started) openChannels(pc);
    emitStatus();
  }

  function onChannel(ch, pc, origin) {
    const label = ch.label;
    if (label === 'collections') {
      setMainPc(pc);
      ch.addEventListener('message', async (ev) => {
        try {
          const bytes = await P.maybeGunzip(await toBytes(ev.data));
          const d = P.decodeDevice(bytes);
          if (d) addDevices([d]);
          const chats = handleChatBytes(bytes, 'collections');
          if (!d && !chats) rawStrings('collections', bytes);
        } catch (e) {
          /* inne wiadomości kanału – ignorujemy */
        }
      });
    } else if (label === 'meet_messages') {
      ch.addEventListener('message', async (ev) => {
        try {
          const bytes = await P.maybeGunzip(await toBytes(ev.data));
          if (!handleChatBytes(bytes, 'meet_messages')) rawStrings('meet_messages', bytes);
        } catch (e) {
          err('meet_messages', e);
        }
      });
      log(`podpięto kanał meet_messages (${origin})`);
    } else if (label === 'media-session') {
      S.mediaSession = ch;
      S.lastOp = 0;
      S.lastSeq = 0;
      const onOpen = () => maybeSendLanguage();
      if (ch.readyState === 'open') onOpen();
      else ch.addEventListener('open', onOpen, { once: true });
    } else if (CAPTION_LABELS.includes(label)) {
      // Kanał otwarty przez Meet albo inny dodatek – słuchamy go
      // biernie, a gdy się zamknie, otwieramy własny.
      if (label === 'captions_v2' && origin === 'local') {
        S.meetCreatedV2.add(pc);
        ch.addEventListener('close', () => {
          S.meetCreatedV2.delete(pc);
          log('cudzy kanał captions_v2 zamknięty – otwieram własny');
          setTimeout(() => reopenIfNeeded(pc, 'captions_v2'), 1000);
        });
      }
      attachCaptions(ch, pc, origin);
    }
  }

  // ------------------------------------------------------------------
  // Czat
  // ------------------------------------------------------------------
  // Zwraca liczbę znalezionych wiadomości czatu (0 = pakiet bez czatu).
  function handleChatBytes(bytes, source) {
    const list = P.findChatMessages(bytes);
    for (const c of list) {
      S.chatCount++;
      emit('chat', { ...c, source });
    }
    if (list.length) log(`czat (${source}): ${list.length} wiadomości`);
    return list.length;
  }

  // W trybie debug zapisujemy czytelne napisy z nieznanych pakietów,
  // żeby było widać, którędy płyną np. wiadomości czatu.
  function rawStrings(label, bytes) {
    if (!S.debug) return;
    const strs = P.strings(bytes, 15);
    if (strs.length) emit('raw', { label, note: 'strings', len: bytes.length, strings: strs });
  }

  // ------------------------------------------------------------------
  // Uczestnicy
  // ------------------------------------------------------------------
  function addDevices(list) {
    let changed = false;
    for (const d of list) {
      if (S.devices[d.deviceId] !== d.name) {
        S.devices[d.deviceId] = d.name;
        changed = true;
        emit('device', d);
      }
    }
    if (changed) emitStatus();
  }

  const SELF_RE = /spaces\/[A-Za-z0-9_-]+\/devices\/[A-Za-z0-9_-]+/;
  function findSelf(body) {
    if (S.selfDevice || !body) return;
    const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
    const m = text.match(SELF_RE);
    if (m) {
      S.selfDevice = m[0];
      emit('self', { deviceId: S.selfDevice });
    }
  }

  function b64ToBytes(t) {
    const bin = atob(t.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ------------------------------------------------------------------
  // Status dla content scriptu
  // ------------------------------------------------------------------
  function emitStatus() {
    emit('status', {
      hooked: true,
      started: S.started,
      language: S.language,
      mainPc: !!S.mainPc,
      pcState: S.mainPc ? S.mainPc.connectionState : null,
      channels: S.channels.map((c) => ({ label: c.label, origin: c.origin, state: c.ch.readyState, current: c.pc === S.mainPc })),
      counts: S.counts,
      lastPacketAt: S.lastPacketAt,
      mediaSession: S.mediaSession ? S.mediaSession.readyState : null,
      devices: S.devices,
      selfDevice: S.selfDevice,
      errors: S.errors.slice(-5),
      chatCount: S.chatCount,
    });
  }

  // ------------------------------------------------------------------
  // Instalacja hooków
  // ------------------------------------------------------------------
  function install() {
    const NativePC = window.RTCPeerConnection;
    if (!NativePC || typeof RTCDataChannel === 'undefined') {
      err('install', 'brak RTCPeerConnection');
      return false;
    }
    nativeCreate = NativePC.prototype.createDataChannel;
    nativeSend = RTCDataChannel.prototype.send;

    NativePC.prototype.createDataChannel = function () {
      const ch = nativeCreate.apply(this, arguments);
      try {
        if (ch && !S.own.has(ch)) onChannel(ch, this, 'local');
      } catch (e) {
        err('createDataChannel hook', e);
      }
      return ch;
    };

    RTCDataChannel.prototype.send = function (data) {
      if (this.label === 'media-session') {
        try {
          trackMediaSessionSend(data);
        } catch (e) {
          /* nie blokujemy wysyłki Meet */
        }
      }
      return nativeSend.apply(this, arguments);
    };

    function HookedPC() {
      const pc = Reflect.construct(NativePC, arguments, new.target || HookedPC);
      pc.addEventListener('datachannel', (e) => {
        try {
          onChannel(e.channel, pc, 'remote');
        } catch (er) {
          err('datachannel', er);
        }
      });
      pc.addEventListener('connectionstatechange', () => {
        if ((pc.connectionState === 'closed' || pc.connectionState === 'failed') && S.mainPc === pc) {
          S.mainPc = null;
          log(`główne połączenie: ${pc.connectionState}`);
        }
        emitStatus();
      });
      return pc;
    }
    HookedPC.prototype = NativePC.prototype;
    Object.setPrototypeOf(HookedPC, NativePC);
    window.RTCPeerConnection = HookedPC;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = HookedPC;

    const nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      const p = nativeFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (url.startsWith(URLS.sync)) {
          if (init && init.body) findSelf(init.body);
          p.then((r) => r.clone().text())
            .then((t) => addDevices(P.decodeCollection(b64ToBytes(t))))
            .catch(() => {});
        } else if (url.startsWith(URLS.createMessage)) {
          // własna wiadomość na czacie (stary czat Meet)
          p.then((r) => r.clone().text())
            .then((t) => handleChatBytes(b64ToBytes(t), 'create-message'))
            .catch(() => {});
        } else if (url.startsWith(URLS.createDevice)) {
          p.then((r) => r.clone().text())
            .then((t) => findSelf(b64ToBytes(t)))
            .catch(() => {});
        }
      } catch (e) {
        /* nie przeszkadzamy Meet */
      }
      return p;
    };
    return true;
  }

  // ------------------------------------------------------------------
  // Polecenia z content scriptu
  // ------------------------------------------------------------------
  document.addEventListener('protokolant:cs', (ev) => {
    let cmd;
    try {
      cmd = JSON.parse(ev.detail);
    } catch (e) {
      return;
    }
    switch (cmd.type) {
      case 'config':
        S.debug = !!cmd.debug;
        S.language = cmd.language || null;
        emitStatus();
        break;
      case 'start':
        S.debug = !!cmd.debug;
        S.language = cmd.language || null;
        if (!S.started) log('start przechwytywania napisów');
        S.started = true;
        S.langSentAt = 0;
        if (S.mainPc) openChannels(S.mainPc);
        maybeSendLanguage();
        emitStatus();
        break;
      case 'stop':
        S.started = false;
        emitStatus();
        break;
      case 'status':
        emitStatus();
        break;
    }
  });

  const ok = install();
  document.documentElement.setAttribute('data-protokolant-hook', ok ? '1' : '0');
  log(ok ? 'hook RTCPeerConnection zainstalowany' : 'hook NIE zainstalowany');
})();
