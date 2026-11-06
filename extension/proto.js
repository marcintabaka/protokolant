/*
 * Minimalny koder/dekoder protobuf i schematy wiadomości Meet (kanały WebRTC).
 * Format ustalony na podstawie ruchu kanałów danych Meet (stan: listopad 2026).
 *
 * captions_v2:  CaptionsV2Packet { 1: utterance { 1: utteranceId int64, 2: version int64,
 *                                  3: caption { 3: text, 4: languageCode, 6: deviceId } } }
 *               ack: { 1: { 1: { 1: utteranceId, 2: version, 3: 1 } } }
 * captions:     { 1: message { 1: deviceId, 2: messageId int64, 3: version int64, 6: text, 8: langId },
 *                 2: unknown2 (pakiet kontrolny) }   – bywa skompresowany gzipem
 * collections:  { 1: { 2: { 13: { 1: { 2: { 1: deviceId, 2: deviceName } } } } } }
 * SyncMeetingSpaceCollections (odpowiedź base64): { 2: { 2: { 2[]: { 1: deviceId, 2: deviceName } } } }
 * media-session: wysyłka: { 1: { 2: { 1: op, 3: { 1: { 9: { 1: lang, 2: lang } }, 2: { 1: "client_config.caption_config" } } } } }
 *                ack:     { 1: { 1: { 2: seq, 3: 1 } } }
 *
 * Czysty JS, działa w przeglądarce (MAIN world) i w Node (testy).
 */
(function (g) {
  'use strict';

  const td = new TextDecoder();
  const te = new TextEncoder();

  function readVarint(buf, pos) {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (pos >= buf.length) throw new Error('varint: koniec danych');
      const b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return [result, pos];
      shift += 7n;
      if (shift > 70n) throw new Error('varint: za długi');
    }
  }

  // Lista pól wiadomości: {f, wt, v}. Rzuca wyjątek dla niepoprawnych bajtów.
  function parse(buf) {
    const fields = [];
    let pos = 0;
    while (pos < buf.length) {
      let key;
      [key, pos] = readVarint(buf, pos);
      const f = Number(key >> 3n);
      const wt = Number(key & 7n);
      if (f === 0) throw new Error('pole 0');
      if (wt === 0) {
        let v;
        [v, pos] = readVarint(buf, pos);
        fields.push({ f, wt, v });
      } else if (wt === 2) {
        let len;
        [len, pos] = readVarint(buf, pos);
        const n = Number(len);
        if (pos + n > buf.length) throw new Error('len: koniec danych');
        fields.push({ f, wt, v: buf.subarray(pos, pos + n) });
        pos += n;
      } else if (wt === 1 || wt === 5) {
        const n = wt === 1 ? 8 : 4;
        if (pos + n > buf.length) throw new Error('fixed: koniec danych');
        fields.push({ f, wt, v: buf.subarray(pos, pos + n) });
        pos += n;
      } else {
        throw new Error(`nieobsługiwany wire type ${wt}`);
      }
    }
    return fields;
  }

  const get = (fields, f, wt) => fields.find((x) => x.f === f && (wt === undefined || x.wt === wt));
  const str = (fields, f) => {
    const x = get(fields, f, 2);
    return x ? td.decode(x.v) : null;
  };
  const int = (fields, f) => {
    const x = get(fields, f, 0);
    return x ? x.v : null;
  };

  // Schodzi po ścieżce zagnieżdżonych wiadomości; zwraca bajty albo null.
  function msgAt(buf, path) {
    let cur = buf;
    for (const f of path) {
      const x = get(parse(cur), f, 2);
      if (!x) return null;
      cur = x.v;
    }
    return cur;
  }

  // ---- kodowanie ----
  function varint(n) {
    let v = BigInt(n);
    const out = [];
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v) b |= 0x80;
      out.push(b);
    } while (v);
    return out;
  }

  function concat(parts) {
    const len = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  const fVarint = (f, n) => Uint8Array.from([...varint((f << 3) | 0), ...varint(n)]);
  const fBytes = (f, bytes) => concat([Uint8Array.from([...varint((f << 3) | 2), ...varint(bytes.length)]), bytes]);
  const fMsg = (f, ...parts) => fBytes(f, concat(parts));
  const fStr = (f, s) => fBytes(f, te.encode(s));

  // ---- schematy Meet ----
  // Wypowiedź = wiadomość z polami 1 (utteranceId, varint) i 3 (caption z deviceId w polu 6).
  // Starszy układ: packet.1; od listopada 2026 Meet wysyła ją pod packet.1.1
  // (packet.1 = { 1: utterance, 6: { 1: seq } }). Sprawdzamy oba poziomy.
  function findUtterance(buf) {
    let cur = buf;
    for (let depth = 0; depth < 3; depth++) {
      const x = get(parse(cur), 1, 2);
      if (!x) return null;
      cur = x.v;
      let uf;
      try {
        uf = parse(cur);
      } catch (e) {
        return null;
      }
      const cap = get(uf, 3, 2);
      if (get(uf, 1, 0) && cap) {
        try {
          if (get(parse(cap.v), 6, 2)) return { uf, cf: parse(cap.v) };
        } catch (e) {
          /* to nie ta wiadomość */
        }
      }
    }
    return null;
  }

  function decodeCaptionV2(buf) {
    const found = findUtterance(buf);
    if (!found) return { rejected: 'no-caption' };
    const { uf, cf } = found;
    const deviceId = str(cf, 6);
    if (!deviceId) return { rejected: 'no-device' };
    const id = int(uf, 1);
    if (!id) return { rejected: 'no-utterance-id' };
    return { id, version: int(uf, 2) || 0n, deviceId, text: str(cf, 3) || '', lang: str(cf, 4) || '' };
  }

  function encodeCaptionV2Ack(id, version) {
    return fMsg(1, fMsg(1, fVarint(1, id), fVarint(2, version), fVarint(3, 1)));
  }

  function decodeCaptionLegacy(buf) {
    const w = parse(buf);
    if (get(w, 2, 2)) return { control: true };
    const m = get(w, 1, 2);
    if (!m) return { rejected: 'no-message' };
    const mf = parse(m.v);
    const deviceId = str(mf, 1);
    const id = int(mf, 2);
    const version = int(mf, 3);
    const langId = int(mf, 8);
    if (!deviceId || !id || !version || !langId) return { rejected: 'incomplete' };
    return { id, version, deviceId, text: str(mf, 6) || '', lang: String(langId) };
  }

  function decodeDevice(buf) {
    const x = msgAt(buf, [1, 2, 13, 1, 2]);
    if (!x) return null;
    const f = parse(x);
    const deviceId = str(f, 1);
    const name = str(f, 2);
    return deviceId && name ? { deviceId, name } : null;
  }

  function decodeCollection(buf) {
    const x = msgAt(buf, [2, 2]);
    if (!x) return [];
    return parse(x)
      .filter((y) => y.f === 2 && y.wt === 2)
      .map((y) => {
        const f = parse(y.v);
        return { deviceId: str(f, 1), name: str(f, 2) };
      })
      .filter((d) => d.deviceId && d.name);
  }

  function mediaSessionOp(buf) {
    try {
      const cmd = msgAt(buf, [1, 2]);
      const v = cmd && int(parse(cmd), 1);
      return v == null ? null : Number(v);
    } catch (e) {
      return null;
    }
  }

  function mediaSessionAckSeq(buf) {
    try {
      const ack = msgAt(buf, [1, 1]);
      const v = ack && int(parse(ack), 2);
      return v == null ? null : Number(v);
    } catch (e) {
      return null;
    }
  }

  function encodeCaptionLanguage(op, code) {
    return fMsg(
      1,
      fMsg(
        2,
        fVarint(1, op),
        fMsg(3, fMsg(1, fMsg(9, fStr(1, code), fStr(2, code))), fMsg(2, fStr(1, 'client_config.caption_config')))
      )
    );
  }

  function encodeMediaSessionAck(seq) {
    return fMsg(1, fMsg(1, fVarint(2, seq), fVarint(3, 1)));
  }

  // ---- czat ----
  const tdFatal = new TextDecoder('utf-8', { fatal: true });
  function asText(bytes) {
    try {
      const s = tdFatal.decode(bytes);
      return /[\x00-\x08\x0e-\x1f]/.test(s) ? null : s;
    } catch (e) {
      return null;
    }
  }

  // Odwiedza wiadomość i wszystkie zagnieżdżone pola LEN, które dają się sparsować.
  function walk(buf, depth, visit) {
    let fields;
    try {
      fields = parse(buf);
    } catch (e) {
      return;
    }
    visit(fields);
    if (depth >= 8) return;
    for (const x of fields) if (x.wt === 2 && x.v.length) walk(x.v, depth + 1, visit);
  }

  const DEVICE_RE = /^spaces\/[^/]+\/devices\/[^/]+$/;

  // Wiadomość czatu: { 1: "spaces/…/messages/…", 2: deviceId, 3: timestamp, 5: { 1: tekst } }.
  // Szukamy jej na dowolnej głębokości, bo opakowania zmieniają się między wersjami Meet.
  function findChatMessages(buf) {
    const out = [];
    walk(buf, 0, (fields) => {
      const dev = get(fields, 2, 2);
      const deviceId = dev && asText(dev.v);
      if (!deviceId || !DEVICE_RE.test(deviceId)) return;
      const t = get(fields, 5, 2);
      if (!t) return;
      let text = null;
      try {
        const tf = get(parse(t.v), 1, 2);
        text = tf && asText(tf.v);
      } catch (e) {
        return;
      }
      if (!text || !text.trim()) return;
      const name = get(fields, 1, 2);
      const ts = int(fields, 3);
      const id = (name && asText(name.v)) || `${ts}/${deviceId}`;
      out.push({ id, deviceId, text, ts: ts == null ? null : Number(ts) });
    });
    return out;
  }

  // Czytelne napisy z wiadomości – do logów diagnostycznych.
  function strings(buf, max = 30) {
    const out = new Set();
    walk(buf, 0, (fields) => {
      for (const x of fields) {
        if (x.wt !== 2 || x.v.length < 2) continue;
        const s = asText(x.v);
        if (s && /\p{L}/u.test(s)) out.add(s.slice(0, 200));
      }
    });
    return [...out].slice(0, max);
  }

  function isGzip(b, o) {
    return b.length > o + 2 && b[o] === 31 && b[o + 1] === 139 && b[o + 2] === 8;
  }

  // Meet czasem kompresuje pakiety gzipem (od bajtu 0 albo 3).
  async function maybeGunzip(u8) {
    const off = isGzip(u8, 0) ? 0 : isGzip(u8, 3) ? 3 : -1;
    if (off < 0) return u8;
    const stream = new Blob([u8.subarray(off)]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Szkielet wiadomości do logów diagnostycznych, np. "1:LEN(40){1:VARINT 3:LEN(12)}".
  function skeleton(buf, depth = 0) {
    try {
      return parse(buf)
        .map((x) => {
          if (x.wt !== 2) return `${x.f}:${x.wt === 0 ? 'VARINT' : x.wt === 1 ? 'I64' : 'I32'}`;
          let inner = '';
          if (depth < 3 && x.v.length) {
            try {
              inner = `{${skeleton(x.v, depth + 1)}}`;
            } catch (e) {
              inner = '';
            }
          }
          return `${x.f}:LEN(${x.v.length})${inner}`;
        })
        .join(' ');
    } catch (e) {
      return `not-protobuf(${buf.length})`;
    }
  }

  g.ProtokolantProto = {
    parse,
    decodeCaptionV2,
    encodeCaptionV2Ack,
    decodeCaptionLegacy,
    decodeDevice,
    decodeCollection,
    mediaSessionOp,
    mediaSessionAckSeq,
    encodeCaptionLanguage,
    encodeMediaSessionAck,
    maybeGunzip,
    findChatMessages,
    strings,
    skeleton,
    _enc: { fVarint, fMsg, fStr },
  };
})(globalThis);
