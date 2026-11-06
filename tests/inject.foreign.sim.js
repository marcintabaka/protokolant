// Scenariusz: inny dodatek albo sam Meet otwiera captions_v2 przed nami. Uruchom: node tests/inject.foreign.sim.js
const listeners = {};
const ET = class { constructor(){this.l={}} addEventListener(t,f){(this.l[t]=this.l[t]||[]).push(f)} fire(t,e){(this.l[t]||[]).forEach(f=>f(e))} };
globalThis.CustomEvent = class { constructor(type, o){ this.type=type; this.detail=o&&o.detail } };
globalThis.document = { dispatchEvent(e){ (listeners[e.type]||[]).forEach(f=>f(e)) }, addEventListener(t,f){(listeners[t]=listeners[t]||[]).push(f)}, documentElement:{ setAttribute(){} } };
globalThis.window = globalThis;
class RTCDataChannel extends ET { constructor(label){super(); this.label=label; this.readyState='connecting'} send(){} }
globalThis.RTCDataChannel = RTCDataChannel;
class RTCPeerConnection extends ET { constructor(){super(); this.connectionState='connected'; this.created=[]} createDataChannel(label){ const c=new RTCDataChannel(label); this.created.push(c); return c } }
globalThis.RTCPeerConnection = RTCPeerConnection;
globalThis.fetch = async () => ({});
require('../extension/proto.js'); require('../extension/inject.js');
const assert = (c, m) => { console.log((c?'OK  ':'FAIL')+' '+m); if(!c) process.exitCode=1 };
const pc = new window.RTCPeerConnection();
pc.fire('datachannel', {channel: new RTCDataChannel('collections')});
const foreign = pc.createDataChannel('captions_v2'); foreign.readyState='open';   // kanał innego dodatku
document.dispatchEvent(new CustomEvent('protokolant:cs', {detail: JSON.stringify({type:'start'})}));
assert(pc.created.map(c=>c.label).join()==='captions_v2,captions', 'przy cudzym v2 otwieramy tylko legacy: '+pc.created.map(c=>c.label));
foreign.readyState='closed'; foreign.fire('close', {});
setTimeout(() => assert(pc.created.map(c=>c.label).join()==='captions_v2,captions,captions_v2', 'po zamknięciu cudzego v2 otwieramy własny: '+pc.created.map(c=>c.label)), 1100);
