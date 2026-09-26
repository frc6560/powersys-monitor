/*
 * Minimal read-only NetworkTables 4 (NT4) client for the browser.
 *
 * Connects to the roboRIO's NT4 WebSocket server (port 5810), subscribes to a
 * topic prefix, and calls back with (topicName, value) as values arrive. Enough
 * to drive a live dashboard — it does not publish or do RTT time-sync.
 *
 * NT4 wire format: JSON text frames carry control messages (announce / subscribe
 * / …); binary frames carry MessagePack-encoded value updates, each a 4-element
 * array [topicId, serverTimeUs, typeId, value]. See the WPILib NT4 spec.
 */
window.PM = window.PM || {};

// ---- tiny MessagePack decoder (only the subset NT4 uses) ----
class Unpacker {
  constructor(arrayBuffer) {
    this.dv = new DataView(arrayBuffer);
    this.u8 = new Uint8Array(arrayBuffer);
    this.o = 0;
    this.len = arrayBuffer.byteLength;
  }
  hasMore() { return this.o < this.len; }
  _str(n) {
    const s = new TextDecoder().decode(this.u8.subarray(this.o, this.o + n));
    this.o += n; return s;
  }
  _bin(n) { const b = this.u8.slice(this.o, this.o + n); this.o += n; return b; }
  decode() {
    const b = this.u8[this.o++];
    if (b <= 0x7f) return b;                       // positive fixint
    if (b >= 0xe0) return b - 256;                 // negative fixint
    if (b >= 0x80 && b <= 0x8f) return this._map(b & 0x0f);
    if (b >= 0x90 && b <= 0x9f) return this._arr(b & 0x0f);
    if (b >= 0xa0 && b <= 0xbf) return this._str(b & 0x1f); // fixstr
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: { const n = this.dv.getUint8(this.o); this.o += 1; return this._bin(n); }
      case 0xc5: { const n = this.dv.getUint16(this.o); this.o += 2; return this._bin(n); }
      case 0xc6: { const n = this.dv.getUint32(this.o); this.o += 4; return this._bin(n); }
      case 0xca: { const v = this.dv.getFloat32(this.o); this.o += 4; return v; }
      case 0xcb: { const v = this.dv.getFloat64(this.o); this.o += 8; return v; }
      case 0xcc: { const v = this.dv.getUint8(this.o); this.o += 1; return v; }
      case 0xcd: { const v = this.dv.getUint16(this.o); this.o += 2; return v; }
      case 0xce: { const v = this.dv.getUint32(this.o); this.o += 4; return v; }
      case 0xcf: { const v = Number(this.dv.getBigUint64(this.o)); this.o += 8; return v; }
      case 0xd0: { const v = this.dv.getInt8(this.o); this.o += 1; return v; }
      case 0xd1: { const v = this.dv.getInt16(this.o); this.o += 2; return v; }
      case 0xd2: { const v = this.dv.getInt32(this.o); this.o += 4; return v; }
      case 0xd3: { const v = Number(this.dv.getBigInt64(this.o)); this.o += 8; return v; }
      case 0xd9: { const n = this.dv.getUint8(this.o); this.o += 1; return this._str(n); }
      case 0xda: { const n = this.dv.getUint16(this.o); this.o += 2; return this._str(n); }
      case 0xdb: { const n = this.dv.getUint32(this.o); this.o += 4; return this._str(n); }
      case 0xdc: { const n = this.dv.getUint16(this.o); this.o += 2; return this._arr(n); }
      case 0xdd: { const n = this.dv.getUint32(this.o); this.o += 4; return this._arr(n); }
      case 0xde: { const n = this.dv.getUint16(this.o); this.o += 2; return this._map(n); }
      case 0xdf: { const n = this.dv.getUint32(this.o); this.o += 4; return this._map(n); }
      default: throw new Error('msgpack: unknown byte 0x' + b.toString(16));
    }
  }
  _arr(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.decode(); return a; }
  _map(n) { const m = {}; for (let i = 0; i < n; i++) { const k = this.decode(); m[k] = this.decode(); } return m; }
}

PM.NT4 = class {
  /**
   * @param {string} host      roboRIO address (e.g. "10.65.60.2" or "roborio-6560-frc.local")
   * @param {string} prefix    topic prefix to subscribe to (e.g. "/PowerMonitor")
   * @param {(name:string,value:*)=>void} onValue
   * @param {(state:string)=>void} onState   "connecting" | "live" | "closed"
   */
  constructor(host, prefix, onValue, onState) {
    this.host = host;
    this.prefix = prefix;
    this.onValue = onValue;
    this.onState = onState || (() => {});
    this.topics = {};          // id -> name
    this.ws = null;
    this.closedByUser = false;
    this._client = 'ccpower_' + Math.floor(Math.random() * 1e6);
  }

  connect() {
    this.closedByUser = false;
    this.onState('connecting');
    const url = `ws://${this.host}:5810/nt/${this._client}`;
    let ws;
    try {
      ws = new WebSocket(url, ['v4.1.networktables.first.wpi.edu', 'networktables.first.wpi.edu']);
    } catch (e) { this.onState('closed'); return; }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      // Subscribe to everything under the prefix.
      ws.send(JSON.stringify([{
        method: 'subscribe',
        params: { topics: [this.prefix], subuid: 1, options: { prefix: true } },
      }]));
      this.onState('live');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') this._onText(ev.data);
      else this._onBinary(ev.data);
    };
    ws.onclose = () => {
      this.onState('closed');
      if (!this.closedByUser) setTimeout(() => this.connect(), 1500); // auto-reconnect
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }

  disconnect() {
    this.closedByUser = true;
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
  }

  _onText(text) {
    let msgs;
    try { msgs = JSON.parse(text); } catch (e) { return; }
    for (const m of msgs) {
      if (m.method === 'announce') this.topics[m.params.id] = m.params.name;
      else if (m.method === 'unannounce') delete this.topics[m.params.id];
    }
  }

  _onBinary(buf) {
    let up;
    try { up = new Unpacker(buf); } catch (e) { return; }
    while (up.hasMore()) {
      let msg;
      try { msg = up.decode(); } catch (e) { break; }
      if (!Array.isArray(msg) || msg.length < 4) continue;
      const id = msg[0], value = msg[3];
      if (id === -1) continue;               // RTT / time-sync, ignored
      const name = this.topics[id];
      if (name !== undefined) this.onValue(name, value);
    }
  }
};
