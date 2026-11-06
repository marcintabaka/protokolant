// Symulacja inject.js z atrapą WebRTC. Uruchom: node tests/inject.sim.js
const listeners = {};
const ET = class { constructor(){this.l={}} addEventListener(t,f){(this.l[t]=this.l[t]||[]).push(f)} fire(t,e){(this.l[t]||[]).forEach(f=>f(e))} };
globalThis.CustomEvent = class { constructor(type, o){ this.type=type; this.detail=o&&o.detail } };
globalThis.document = { dispatchEvent(e){ (listeners[e.type]||[]).forEach(f=>f(e)) }, addEventListener(t,f){(listeners[t]=listeners[t]||[]).push(f)}, documentElement:{ setAttribute(k,v){ this[k]=v } } };
globalThis.window = globalThis;
const sent = [];
class RTCDataChannel extends ET { constructor(label){super(); this.label=label; this.readyState='connecting'; this.binaryType='blob'} send(d){ sent.push({label:this.label, bytes:new Uint8Array(d)}) } }
globalThis.RTCDataChannel = RTCDataChannel;
class RTCPeerConnection extends ET { constructor(){super(); this.connectionState='connected'; this.created=[]} createDataChannel(label, o){ const c=new RTCDataChannel(label); c.opts=o; this.created.push(c); return c } }
globalThis.RTCPeerConnection = RTCPeerConnection;
globalThis.fetch = async () => ({ clone(){ return { text: async () => '' } } });
require('../extension/proto.js'); require('../extension/inject.js');
const P = globalThis.ProtokolantProto, E = P._enc;
const events = []; document.addEventListener('protokolant:page', e => events.push(JSON.parse(e.detail)));
const assert = (c, m) => { console.log((c?'OK  ':'FAIL')+' '+m); if(!c) process.exitCode=1 };

const pc = new window.RTCPeerConnection();
assert(pc instanceof RTCPeerConnection, 'hooked PC is instance of native');
const coll = new RTCDataChannel('collections'); pc.fire('datachannel', {channel: coll});
const ms = pc.createDataChannel('media-session'); ms.readyState='open';
ms.send(P.encodeCaptionLanguage(7, 'en-US')); ms.send(P.encodeMediaSessionAck(3));  // Meet's own sends -> tracked op=7 seq=3
document.dispatchEvent(new CustomEvent('protokolant:cs', {detail: JSON.stringify({type:'start', language:'pl-PL'})}));
const own = pc.created.filter(c => c.label.startsWith('captions'));
assert(own.map(c=>c.label).join()==='captions,captions_v2', 'own captions channels created: '+own.map(c=>c.label));
const v2 = own.find(c=>c.label==='captions_v2'); v2.readyState='open'; v2.fire('open',{});
const langPkts = sent.filter(s=>s.label==='media-session').slice(2);
assert(langPkts.length===3 && P.mediaSessionOp(langPkts[0].bytes)===8 && P.mediaSessionAckSeq(langPkts[1].bytes)===4 && P.mediaSessionAckSeq(langPkts[2].bytes)===5, 'language packet op=8, acks seq=4,5');
// device name via collections
const dev = E.fMsg(1, E.fMsg(2, E.fMsg(13, E.fMsg(1, E.fMsg(2, E.fStr(1,'spaces/S/devices/d1'), E.fStr(2,'Jan Kowalski'))))));
coll.fire('message', {data: dev.buffer});
const chatMsg = E.fMsg(1, E.fMsg(2, E.fMsg(13, E.fMsg(4, E.fStr(1,'x'), E.fMsg(2, E.fStr(1,'spaces/S/messages/abc'), E.fStr(2,'spaces/S/devices/d1'), E.fVarint(3, 1793881930123456n), E.fMsg(5, E.fStr(1,'https://example.com')))))));
coll.fire('message', {data: chatMsg.buffer});
const mm = pc.createDataChannel('meet_messages'); mm.fire('message', {data: E.fMsg(2, E.fStr(1,'spaces/S/messages/def'), E.fStr(2,'spaces/S/devices/d1'), E.fMsg(5, E.fStr(1,'druga'))).buffer});
// captions v2 packets: utterance 100 v1, v2
const cap = (id, ver, text) => E.fMsg(1, E.fVarint(1,id), E.fVarint(2,ver), E.fMsg(3, E.fStr(3,text), E.fStr(4,'pl-PL'), E.fStr(6,'spaces/S/devices/d1')));
v2.fire('message', {data: cap(100,1,'Dzień').buffer});
v2.fire('message', {data: cap(100,2,'Dzień dobry').buffer});
// nowy układ (Meet, listopad 2026): packet.1 = { 1: utterance, 6: { 1: seq } }, caption z polami 5 i 9
const capNew = (id, ver, text) => E.fMsg(1, E.fMsg(1, E.fVarint(1,id), E.fVarint(2,ver), E.fMsg(3, E.fStr(3,text), E.fStr(4,'pl-PL'), E.fStr(5,'pl-PL'), E.fStr(6,'spaces/S/devices/d1'), E.fVarint(9,1))), E.fMsg(6, E.fVarint(1, 77)));
v2.fire('message', {data: capNew(200,1,'Nowy format').buffer});
// pakiety kontrolne z logu nie mogą dawać wypowiedzi
v2.fire('message', {data: E.fMsg(1, E.fMsg(1, E.fVarint(2,1), E.fStr(6,'')), E.fMsg(6, E.fVarint(1,1))).buffer});
// legacy channel duplicate of same content (gzip off)
const leg = own.find(c=>c.label==='captions');
const legacy = E.fMsg(1, E.fStr(1,'spaces/S/devices/d1'), E.fVarint(2,555), E.fVarint(3,2), E.fStr(6,'Dzień dobry'), E.fVarint(8,39));
leg.fire('message', {data: legacy.buffer});
setTimeout(() => {
  const caps = events.filter(e=>e.type==='caption');
  assert(caps.length===3 && caps[2].mid.startsWith('200/') && caps[2].text==='Nowy format', 'caption events (legacy pominięty, nowy format odczytany): '+caps.map(c=>`${c.mid} v${c.version} "${c.text}"`).join(' | '));
  const acks = sent.filter(s=>s.label==='captions_v2');
  assert(acks.length===3 && P.parse(acks[1].bytes).length===1, 'acks sent for v2: '+acks.length);
  assert(events.some(e=>e.type==='device' && e.name==='Jan Kowalski'), 'device name decoded');
  const chats = events.filter(e=>e.type==='chat');
  assert(chats.length===2 && chats[0].id==='spaces/S/messages/abc' && chats[0].text==='https://example.com' && chats[1].text==='druga', 'czat z collections i meet_messages: '+JSON.stringify(chats.map(c=>[c.source,c.text])));
  document.dispatchEvent(new CustomEvent('protokolant:cs', {detail: JSON.stringify({type:'status'})}));
  const st = events.filter(e=>e.type==='status').pop();
  assert(st.mainPc && st.counts.captions_v2.caption===3 && st.counts.captions_v2.rejected===1 && st.counts.captions.skipped===1, 'status counts: '+JSON.stringify(st.counts));
}, 50);
