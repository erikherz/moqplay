/*! Copyright © 2026 Erik Herz. All rights reserved. */

/**
 * moqt-player.js — Custom low-latency MoQT player.
 *
 * Connects to a Cloudflare MoQ relay via WebTransport, subscribes to
 * tracks using MoQ Transport draft-14 wire format, and feeds CMAF
 * fragments directly into MSE SourceBuffers for sub-second latency.
 *
 * Depends on fragment-appender.js (window.FragmentAppender, window.hasMoov, window.hasMoof)
 */

// --- §1 QUIC Variable-Length Integer (RFC 9000 §16) ---

function encodeVarint(v) {
  if (v < 0) throw new Error('negative varint');
  if (v <= 63) return new Uint8Array([v]);
  if (v <= 16383) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v | 0x4000);
    return b;
  }
  if (v <= 1073741823) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, (v | 0x80000000) >>> 0);
    return b;
  }
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v) | 0xc000000000000000n);
  return b;
}

// --- §2 Stream Reader / Writer ---

class MoqReader {
  #buf = new Uint8Array(0);
  #reader;

  constructor(readable) {
    if (readable instanceof ReadableStream) {
      this.#reader = readable.getReader();
    } else {
      // readable is a Uint8Array buffer (for message body decoding)
      this.#buf = readable;
      this.#reader = null;
    }
  }

  async #fill() {
    if (!this.#reader) return false;
    const { done, value } = await this.#reader.read();
    if (done || !value) return false;
    const chunk = new Uint8Array(value);
    if (this.#buf.byteLength === 0) {
      this.#buf = chunk;
    } else {
      const merged = new Uint8Array(this.#buf.byteLength + chunk.byteLength);
      merged.set(this.#buf);
      merged.set(chunk, this.#buf.byteLength);
      this.#buf = merged;
    }
    return true;
  }

  async #fillTo(n) {
    while (this.#buf.byteLength < n) {
      if (!(await this.#fill())) throw new Error('unexpected end of stream');
    }
  }

  #slice(n) {
    const result = new Uint8Array(this.#buf.buffer, this.#buf.byteOffset, n);
    this.#buf = new Uint8Array(this.#buf.buffer, this.#buf.byteOffset + n, this.#buf.byteLength - n);
    return result;
  }

  async read(n) {
    if (n === 0) return new Uint8Array(0);
    await this.#fillTo(n);
    return this.#slice(n);
  }

  async u8() {
    await this.#fillTo(1);
    return this.#slice(1)[0];
  }

  async u16() {
    await this.#fillTo(2);
    const view = new DataView(this.#buf.buffer, this.#buf.byteOffset, 2);
    const val = view.getUint16(0);
    this.#slice(2);
    return val;
  }

  async varint() {
    await this.#fillTo(1);
    const tag = (this.#buf[0] & 0xc0) >> 6;
    const size = 1 << tag;
    await this.#fillTo(size);
    const slice = this.#slice(size);
    const view = new DataView(slice.buffer, slice.byteOffset, size);
    if (size === 1) return slice[0] & 0x3f;
    if (size === 2) return view.getUint16(0) & 0x3fff;
    if (size === 4) return view.getUint32(0) & 0x3fffffff;
    return Number(view.getBigUint64(0) & 0x3fffffffffffffffn);
  }

  async string() {
    const len = await this.varint();
    const bytes = await this.read(len);
    return new TextDecoder().decode(bytes);
  }

  async bool() {
    return (await this.u8()) === 1;
  }

  async done() {
    if (this.#buf.byteLength > 0) return false;
    if (!this.#reader) return true;
    return !(await this.#fill());
  }

  cancel() {
    if (this.#reader) this.#reader.cancel().catch(() => {});
  }
}

// --- Message Builder ---

class MsgBuilder {
  #chunks = [];
  #size = 0;

  varint(v) {
    const b = encodeVarint(v);
    this.#chunks.push(b);
    this.#size += b.byteLength;
    return this;
  }

  u8(v) {
    this.#chunks.push(new Uint8Array([v]));
    this.#size += 1;
    return this;
  }

  string(s) {
    const data = new TextEncoder().encode(s);
    this.varint(data.byteLength);
    this.#chunks.push(data);
    this.#size += data.byteLength;
    return this;
  }

  bool(v) { return this.u8(v ? 1 : 0); }

  bytes(data) {
    this.#chunks.push(new Uint8Array(data));
    this.#size += data.byteLength;
    return this;
  }

  finish() {
    const result = new Uint8Array(this.#size);
    let off = 0;
    for (const c of this.#chunks) { result.set(c, off); off += c.byteLength; }
    return result;
  }
}

// --- Writer wrapper ---

class MoqWriter {
  #writer;
  #lock = Promise.resolve();

  constructor(writable) {
    this.#writer = writable.getWriter();
  }

  async #rawWrite(data) { await this.#writer.write(data); }
  async writeRaw(data) { await this.#rawWrite(data); }

  /** Atomically write a control message: varint(type) + u16(size) + body */
  // After SETUP, moq-lite-02 uses varint lengths instead of u16
  useLiteEncoding = false;

  async writeControlMessage(type, body) {
    const prev = this.#lock;
    let resolve;
    this.#lock = new Promise(r => { resolve = r; });
    await prev;
    try {
      const typeBytes = encodeVarint(type);
      if (this.useLiteEncoding) {
        const sizeBytes = encodeVarint(body.byteLength);
        const combined = new Uint8Array(typeBytes.byteLength + sizeBytes.byteLength + body.byteLength);
        combined.set(typeBytes, 0);
        combined.set(sizeBytes, typeBytes.byteLength);
        combined.set(body, typeBytes.byteLength + sizeBytes.byteLength);
        await this.#rawWrite(combined);
      } else {
        const sizeBytes = new Uint8Array(2);
        new DataView(sizeBytes.buffer).setUint16(0, body.byteLength);
        const combined = new Uint8Array(typeBytes.byteLength + 2 + body.byteLength);
        combined.set(typeBytes, 0);
        combined.set(sizeBytes, typeBytes.byteLength);
        combined.set(body, typeBytes.byteLength + 2);
        await this.#rawWrite(combined);
      }
    } finally {
      resolve();
    }
  }

  close() { this.#writer.close().catch(() => {}); }
}

// --- §3 MoQT Protocol Constants (draft-14) ---

const MOQT_VERSION_DRAFT14 = 0xff00000e;
const MOQT_LITE_V02        = 0xff0dad02;
const MOQT_LITE_V01        = 0xff0dad01;

// moq-lite-03 per-stream ControlType prefixes (first varint on each bidi stream)
const LITE3_CT_SESSION   = 0;
const LITE3_CT_ANNOUNCE  = 1;
const LITE3_CT_SUBSCRIBE = 2;
const LITE3_CT_FETCH     = 3;
const LITE3_CT_PROBE     = 4;

const MSG_CLIENT_SETUP   = 0x20;
const MSG_SERVER_SETUP   = 0x21;
const MSG_SUBSCRIBE      = 0x03;
const MSG_SUBSCRIBE_OK   = 0x04;
const MSG_SUBSCRIBE_ERROR = 0x05;
const MSG_GOAWAY         = 0x10;
const MSG_MAX_REQUEST_ID = 0x15;

const PARAM_MAX_REQUEST_ID  = 2;
const PARAM_IMPLEMENTATION  = 7;

const GROUP_ORDER_DESCENDING = 0x02;
const FILTER_LATEST_GROUP    = 0x01;
const FILTER_LARGEST_OBJECT  = 0x02;
const GROUP_END_STATUS       = 0x03;

const MSG_UNSUBSCRIBE           = 0x0a;
const MSG_PUBLISH_NAMESPACE     = 0x06;
const MSG_PUBLISH_NAMESPACE_OK  = 0x07;
const MSG_PUBLISH_DONE          = 0x0b;
const MSG_PUBLISH               = 0x1d;
const MSG_PUBLISH_ERROR         = 0x1f;

// --- §4 MoqtPlayer ---

class MoqtPlayer {
  constructor(video, relayUrl, namespace, opts = {}) {
    this.video = video;
    this.relayUrl = relayUrl;
    this.namespace = namespace;
    // Register for stats.js auto-discovery
    if (window.MoqtPlayer) window.MoqtPlayer._lastInstance = this;
    this.onStatus = opts.onStatus || (() => {});
    this.onCatalog = opts.onCatalog || (() => {});
    this.startFilter = opts.startFilter === 'latest_group' ? FILTER_LATEST_GROUP : FILTER_LARGEST_OBJECT;

    this.appender = new window.FragmentAppender();
    if (opts.batchSize !== undefined) this.appender.batchSize = opts.batchSize;
    this.trackAliasMap = new Map();   // trackAlias → { name, type:'video'|'audio' }
    this.subscribeCallbacks = new Map(); // requestId → { resolve, reject }
    this.nextReqId = 0;
    this.wt = null;
    this.controlWriter = null;
    this.controlReader = null;
    this.liteEncoding = false;
    this.liteVersion = 0;
    this.catalogReceived = false;
    this.stats = { framesReceived: 0, bytesReceived: 0, startTime: 0 };
    this._playTriggered = false;
    this._initialSeekDone = false;

    // ABR state
    this.abrLadder = [];           // [{name, width, height, initData}] sorted low→high
    this.abrCurrentIndex = -1;
    this.abrActiveTrack = null;    // {name, alias, requestId}
    this.abrSwitching = false;
    this.abrState = 'init';        // init | stable | switching
    this.abrSwitchCount = 0;
    this.abrStableStart = 0;
    this.abrLastDroppedFrames = 0;
    this._abrPendingSwitch = null;
    this._abrInterval = null;

    // Latency control
    this.targetLatency = 2000;     // ms, updated from catalog targetLatency
    this._timescale = { video: 0, audio: 0 };
    this._latestBDT = { video: 0, audio: 0 };
    this._droppedStale = { video: 0, audio: 0 };

    // Pipeline timing instrumentation
    this.timing = {};
  }


  async connect() {
    this.timing.connectStart = performance.now();
    this.onStatus('Connecting...');

    // 1. Connect via WebTransport
    this.wt = await this._connectTransport();
    this.timing.connectDone = performance.now();
    this.transportType = 'webtransport';
    console.log('[MoQT] WebTransport connected, protocol:', this.wt.protocol ?? '(none)');
    this.wt.closed.then(info => {
      console.log('[MoQT] Transport closed:', info);
    }).catch(e => {
      console.error('[MoQT] Transport closed with error:', e);
    });

    // 2. Attach MSE to video element + listen for decode/render events
    this.video.src = this.appender.getObjectURL();
    this.stats.startTime = Date.now();
    this.appender.mediaSource.addEventListener('sourceopen', () => {
      if (!this.timing.mseOpen) this.timing.mseOpen = performance.now();
    }, { once: true });
    // Track every video appendBuffer() call until first decode
    this._videoAppends = [];
    this.appender.onAppend = (type, data) => {
      if (type === 'video' && !this.timing.firstFrameDecoded) {
        const now = performance.now();
        const isInit = window.hasMoov(data);
        this._videoAppends.push({ t: now, bytes: data.byteLength, isInit });
        if (!isInit && !this.timing.firstVideoAppend) {
          this.timing.firstVideoAppend = now;
        }
        console.log(`[MoQT] Video appendBuffer #${this._videoAppends.length}: ${data.byteLength}B ${isInit ? '(init)' : '(moof)'} at ${(now - this.timing.connectStart).toFixed(0)}ms`);

        // After first media append, seek to buffered start on updateend
        if (!isInit && !this._seekOnFirstAppend) {
          this._seekOnFirstAppend = true;
          const sb = this.appender.sourceBuffers.video;
          if (sb) {
            sb.addEventListener('updateend', () => {
              const b = this.video.buffered;
              if (b.length > 0 && this.video.currentTime < b.start(0)) {
                console.log(`[MoQT] Seeking to buffered start on updateend: ${b.start(0).toFixed(3)}s`);
                this.video.currentTime = b.start(0);
              }
            }, { once: true });
          }
        }
      }
    };
    this.video.addEventListener('loadeddata', () => {
      if (!this.timing.firstFrameDecoded) {
        this.timing.firstFrameDecoded = performance.now();
        // Stop batching — flush any remaining buffered fragments, switch to per-fragment appends
        this.appender._firstDecodeFired.video = true;
        this.appender._firstDecodeFired.audio = true;
        this.appender._flushBatch('video');
        this.appender._flushBatch('audio');
        this._logTiming();
      }
    }, { once: true });
    this.video.addEventListener('playing', () => {
      if (!this.timing.firstBlit) {
        this.timing.firstBlit = performance.now();
        this._logTiming();
        // Aggressive initial seek — snap to live edge once playback starts
        setTimeout(() => this._initialSeek(), 100);
      }
    }, { once: true });

    // 3. Protocol setup
    const negotiatedProtocol = this.wt.protocol ?? '';
    if (negotiatedProtocol === 'moq-lite-03') {
      // moq-lite-03: ALPN-only, no SETUP, per-stream bidi for each control message
      this.liteEncoding = true;
      this.liteVersion = 3;
      console.log('[MoQT] moq-lite-03 (ALPN-only) — no SETUP, per-stream control');
      this.onStatus('moq-lite-03 connected');
    } else {
      // Draft-14 / moq-lite-01/02: single bidi control stream with SETUP
      const bidi = await this.wt.createBidirectionalStream();
      this.controlWriter = new MoqWriter(bidi.writable);
      this.controlReader = new MoqReader(bidi.readable);
      this.onStatus('MoQT SETUP...');
      await this._doSetup();
    }
    this.timing.setupDone = performance.now();

    // 4. Start background loops
    if (!this.liteVersion) this._readControlLoop(); // lite-03 reads responses per-stream
    this._readDataStreams();

    // 5. Subscribe to catalog
    this.onStatus('Subscribing to catalog...');
    this.timing.catalogSubSent = performance.now();
    await this._subscribe('catalog', 128);
    this.timing.catalogSubOk = performance.now();

    // 6. Buffer trimming + live-edge seeking
    this._trimLoop();
    this._seekLoop();

    console.log('[MoQT] Waiting for catalog...');
  }

  // --- SETUP Exchange ---

  async _connectTransport() {
    const url = this.relayUrl;
    if (typeof WebTransport === 'undefined') {
      throw new Error('WebTransport not available in this browser');
    }
    const wt = new WebTransport(url, {
      allowPooling: false,
      congestionControl: 'low-latency',
      protocols: ['moq-lite-03', 'moql', 'moqt-16', 'moqt-15'],
    });
    await wt.ready;
    return wt;
  }

  async _doSetup() {
    // CLIENT_SETUP (draft-14 encoding)
    const body = new MsgBuilder()
      .varint(3)                        // num_versions
      .varint(MOQT_VERSION_DRAFT14)    // moq-transport draft-14 (preferred)
      .varint(MOQT_LITE_V02)           // moq-lite draft-02
      .varint(MOQT_LITE_V01)           // moq-lite draft-01
      .varint(2)                        // num_params
      .varint(PARAM_MAX_REQUEST_ID)    // param: MaxRequestId
      .varint(1000)                     // value
      .varint(PARAM_IMPLEMENTATION)    // param: Implementation (odd = bytes)
      .string('moqpush-custom-player') // value
      .finish();

    await this.controlWriter.writeControlMessage(MSG_CLIENT_SETUP, body);

    // SERVER_SETUP
    const serverType = await this.controlReader.varint();
    if (serverType !== MSG_SERVER_SETUP) {
      throw new Error(`Expected SERVER_SETUP (0x21), got 0x${serverType.toString(16)}`);
    }
    const serverBodySize = await this.controlReader.u16();
    const serverBody = await this.controlReader.read(serverBodySize);
    const sr = new MoqReader(serverBody);
    const serverVersion = await sr.varint();
    console.log(`[MoQT] Server version: 0x${serverVersion.toString(16)}`);
    // Read server parameters
    const numParams = await sr.varint();
    for (let i = 0; i < numParams; i++) {
      const paramId = await sr.varint();
      if (paramId % 2 === 0) {
        const val = await sr.varint();
        console.log(`[MoQT] Server param ${paramId}=${val}`);
        if (paramId === PARAM_MAX_REQUEST_ID) {
          this.serverMaxRequestId = val;
          console.log(`[MoQT] Server MaxRequestId: ${val}`);
        }
      } else {
        const len = await sr.varint();
        await sr.read(len); // bytes value
      }
    }

    // Switch to lite encoding for all subsequent messages if moq-lite negotiated
    if (serverVersion === MOQT_LITE_V02 || serverVersion === MOQT_LITE_V01) {
      this.controlWriter.useLiteEncoding = true;
      this.liteEncoding = true;
      this.liteVersion = serverVersion === MOQT_LITE_V02 ? 2 : 1;
      console.log('[MoQT] Switched to moq-lite varint encoding');
    }
  }

  // --- SUBSCRIBE ---

  async _subscribe(trackName, priority) {
    const requestId = this.nextReqId;
    this.nextReqId += 2;

    // If namespace is in the relay URL path (for auth), SUBSCRIBE uses empty namespace
    // Otherwise, SUBSCRIBE includes the namespace
    const urlHasNamespace = this.relayUrl.includes('/' + this.namespace);
    const ns = urlHasNamespace ? '' : this.namespace;

    if (this.liteVersion >= 3) {
      return this._subscribeLite3(requestId, ns, trackName, priority);
    }

    // Draft-14 / moq-lite-01/02: shared control stream
    const body = new MsgBuilder();
    body.varint(requestId);                  // request_id

    if (this.liteEncoding) {
      // moq-lite-01/02: broadcast is a single string (Path), not a tuple
      body.string(ns);                       // broadcast (single string)
      body.string(trackName);                // track name
      body.u8(priority);                     // subscriber_priority
    } else {
      // Draft-14: namespace is a tuple of parts
      const nsParts = ns ? ns.split('/') : [''];
      body.varint(nsParts.length);           // namespace parts count
      for (const part of nsParts) {
        body.string(part);                   // each namespace part
      }
      body.string(trackName);               // track name
      body.u8(priority);                    // subscriber_priority
      body.u8(GROUP_ORDER_DESCENDING);      // group_order = descending
      body.bool(true);                      // forward = true
      body.varint(this.startFilter);         // filter type
      body.varint(0);                       // num_parameters = 0
    }

    const buf = body.finish();
    await this.controlWriter.writeControlMessage(MSG_SUBSCRIBE, buf);

    console.log(`[MoQT] SUBSCRIBE id=${requestId} track="${trackName}"`);
    this.trackAliasMap.set(requestId, { name: trackName, requestId });

    return new Promise((resolve, reject) => {
      this.subscribeCallbacks.set(requestId, { resolve, reject, trackName });
    });
  }

  // moq-lite-03: each subscribe gets its own bidi stream
  async _subscribeLite3(requestId, ns, trackName, priority) {
    const bidi = await this.wt.createBidirectionalStream();
    const writer = new MoqWriter(bidi.writable);
    writer.useLiteEncoding = true;
    const reader = new MoqReader(bidi.readable);

    // Build subscribe body
    const body = new MsgBuilder();
    body.varint(requestId);                  // id
    body.string(ns);                         // broadcast (single string Path)
    body.string(trackName);                  // track name
    body.u8(priority);                       // subscriber_priority
    body.u8(1);                              // ordered = true
    body.varint(0);                          // max_latency = 0ms (no limit)
    body.varint(0);                          // start_group = None
    body.varint(0);                          // end_group = None
    const buf = body.finish();

    // Write: varint(ControlType::Subscribe=2) as stream header, then varint(size) + body
    await writer.writeRaw(encodeVarint(LITE3_CT_SUBSCRIBE));
    // Then the subscribe message: varint(size) + body
    const sizeBytes = encodeVarint(buf.byteLength);
    const msg = new Uint8Array(sizeBytes.byteLength + buf.byteLength);
    msg.set(sizeBytes, 0);
    msg.set(buf, sizeBytes.byteLength);
    await writer.writeRaw(msg);

    console.log(`[MoQT] SUBSCRIBE (lite-03 bidi) id=${requestId} track="${trackName}"`);
    this.trackAliasMap.set(requestId, { name: trackName, requestId });

    // Read SubscribeOk on this same bidi stream
    this._readLite3SubscribeResponse(reader, requestId, trackName);

    return new Promise((resolve, reject) => {
      this.subscribeCallbacks.set(requestId, { resolve, reject, trackName });
    });
  }

  async _readLite3SubscribeResponse(reader, requestId, trackName) {
    try {
      const responseType = await reader.varint(); // 0=Ok, 1=Drop
      const bodySize = await reader.varint();     // size prefix
      if (responseType === 0) {
        // SubscribeOk — no track_alias in lite-03, fields are delivery preferences
        const _priority = await reader.u8();
        const _ordered = await reader.u8();
        const _maxLatency = await reader.varint();
        const _startGroup = await reader.varint();
        const _endGroup = await reader.varint();
        const cb = this.subscribeCallbacks.get(requestId);
        if (cb) {
          // lite-03 uses subscribe request_id as the data stream identifier (no track_alias)
          console.log(`[MoQT] SUBSCRIBE_OK (lite-03) id=${requestId} track="${trackName}"`);
          this.trackAliasMap.set(requestId, { name: trackName, requestId });
          cb.resolve(requestId);
          this.subscribeCallbacks.delete(requestId);
        }
      } else {
        // SubscribeDrop: start, end, error
        const bodyData = await reader.read(bodySize);
        const br = new MoqReader(bodyData);
        const start = await br.varint();
        const end = await br.varint();
        const errorCode = await br.varint();
        const cb = this.subscribeCallbacks.get(requestId);
        if (cb) {
          console.error(`[MoQT] SUBSCRIBE_DROP (lite-03) id=${requestId} error=${errorCode}`);
          cb.reject(new Error(`SUBSCRIBE_DROP (code ${errorCode})`));
          this.subscribeCallbacks.delete(requestId);
        }
      }
    } catch (e) {
      console.error(`[MoQT] lite-03 subscribe response error for "${trackName}":`, e);
    }
  }

  // --- UNSUBSCRIBE ---

  async _unsubscribe(requestId) {
    const body = new MsgBuilder();
    body.varint(requestId);
    const buf = body.finish();
    await this.controlWriter.writeControlMessage(MSG_UNSUBSCRIBE, buf);
    console.log(`[MoQT] UNSUBSCRIBE id=${requestId}`);

    // Clean up alias map entry for this requestId
    for (const [alias, info] of this.trackAliasMap) {
      if (info.requestId === requestId) {
        this.trackAliasMap.delete(alias);
        break;
      }
    }
  }

  // --- Control Message Loop ---

  async _readControlLoop() {
    try {
      while (true) {
        const msgType = await this.controlReader.varint();
        const bodySize = this.liteEncoding ? await this.controlReader.varint() : await this.controlReader.u16();
        const bodyData = await this.controlReader.read(bodySize);
        console.log(`[MoQT] Control msg type=0x${msgType.toString(16)} size=${bodySize}`);
        const br = new MoqReader(bodyData);

        switch (msgType) {
          case MSG_SUBSCRIBE_OK:
            await this._handleSubscribeOk(br);
            break;
          case MSG_SUBSCRIBE_ERROR:
            await this._handleSubscribeError(br);
            break;
          case MSG_PUBLISH: {
            // Relay is announcing a track — respond with PUBLISH_ERROR (we're subscriber-only)
            const pubReqId = await br.varint();
            const pubNsParts = await br.varint();
            for (let i = 0; i < pubNsParts; i++) await br.string();
            const pubTrackName = await br.string();
            console.log(`[MoQT] PUBLISH (announce) id=${pubReqId} track="${pubTrackName}" — sending PUBLISH_ERROR`);
            // Respond with PUBLISH_ERROR (0x1f)
            const errBody = new MsgBuilder()
              .varint(pubReqId)    // request_id
              .varint(500)         // error_code
              .string('subscriber only') // reason
              .finish();
            await this.controlWriter.writeControlMessage(MSG_PUBLISH_ERROR, errBody);
            break;
          }
          case MSG_PUBLISH_DONE: {
            const pdReqId = await br.varint();
            const pdStatus = await br.varint();
            console.log(`[MoQT] PUBLISH_DONE id=${pdReqId} status=${pdStatus}`);
            break;
          }
          case MSG_PUBLISH_NAMESPACE: {
            // Relay announcing a namespace is available — respond with OK
            const pnReqId = await br.varint();
            const pnNsParts = await br.varint();
            const parts = [];
            for (let i = 0; i < pnNsParts; i++) parts.push(await br.string());
            console.log(`[MoQT] PUBLISH_NAMESPACE id=${pnReqId} ns="${parts.join('/')}" — sending OK`);
            // Respond with PUBLISH_NAMESPACE_OK (0x07)
            const okBody = new MsgBuilder().varint(pnReqId).finish();
            await this.controlWriter.writeControlMessage(MSG_PUBLISH_NAMESPACE_OK, okBody);
            break;
          }
          case MSG_MAX_REQUEST_ID: {
            const maxId = await br.varint();
            this.serverMaxRequestId = maxId;
            console.log(`[MoQT] MAX_REQUEST_ID updated: ${maxId}`);
            break;
          }
          case MSG_GOAWAY: {
            const uri = await br.string();
            console.warn(`[MoQT] GOAWAY: ${uri}`);
            break;
          }
          default:
            console.log(`[MoQT] Control message type 0x${msgType.toString(16)} (${bodySize}B body, ignored)`);
        }
      }
    } catch (e) {
      if (!this.wt?.closed) {
        console.error('[MoQT] Control stream error:', e);
      }
    }
  }

  async _handleSubscribeOk(reader) {
    const requestId = await reader.varint();
    const trackAlias = await reader.varint();
    if (!this.liteEncoding) {
      // draft-14: expires + group_order + content_exists + optional largest + params
      const expires = await reader.varint();
      const groupOrder = await reader.u8();
      const contentExists = await reader.bool();
      if (contentExists) {
        await reader.varint(); // largest group
        await reader.varint(); // largest object
      }
      // Discard remaining parameters
      const numParams = await reader.varint();
      for (let i = 0; i < numParams; i++) {
        const pid = await reader.varint();
        if (pid % 2 === 0) { await reader.varint(); }
        else { const len = await reader.varint(); await reader.read(len); }
      }
    }

    const cb = this.subscribeCallbacks.get(requestId);
    if (cb) {
      console.log(`[MoQT] SUBSCRIBE_OK id=${requestId} alias=${trackAlias} track="${cb.trackName}"`);
      this.trackAliasMap.set(trackAlias, { name: cb.trackName, requestId });
      cb.resolve(trackAlias);
      this.subscribeCallbacks.delete(requestId);
    } else {
      console.warn(`[MoQT] SUBSCRIBE_OK for unknown id=${requestId}`);
    }
  }

  async _handleSubscribeError(reader) {
    const requestId = await reader.varint();
    const errorCode = await reader.varint();
    const reason = await reader.string();

    const cb = this.subscribeCallbacks.get(requestId);
    if (cb) {
      console.error(`[MoQT] SUBSCRIBE_ERROR id=${requestId} code=${errorCode}: ${reason}`);
      cb.reject(new Error(`SUBSCRIBE_ERROR: ${reason} (code ${errorCode})`));
      this.subscribeCallbacks.delete(requestId);
    }
  }

  // --- Data Stream Loop ---

  async _readDataStreams() {
    console.log('[MoQT] Data stream reader started, waiting for unidirectional streams...');
    const reader = this.wt.incomingUnidirectionalStreams.getReader();
    let streamCount = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log('[MoQT] incomingUnidirectionalStreams ended');
          break;
        }
        streamCount++;
        console.log(`[MoQT] Unidirectional stream #${streamCount} received`);
        this._handleDataStream(value).catch(e => {
          console.error('[MoQT] Data stream error:', e);
        });
      }
    } catch (e) {
      console.error('[MoQT] Data streams error:', e);
    }
    console.log(`[MoQT] Data stream reader exited after ${streamCount} streams`);
  }

  async _handleDataStream(readable) {
    const r = new MoqReader(readable);

    if (this.liteVersion >= 3) {
      return this._handleDataStreamLite3(r);
    }

    // Draft-14 / moq-lite-01/02: GROUP header with type flags
    const typeId = await r.varint();

    let hasPriority, baseId;
    if (typeId >= 0x10 && typeId <= 0x1f) {
      hasPriority = true; baseId = typeId;
    } else if (typeId >= 0x30 && typeId <= 0x3f) {
      hasPriority = false; baseId = typeId - (0x30 - 0x10);
    } else {
      console.warn(`[MoQT] Unknown group type: 0x${typeId.toString(16)}`);
      r.cancel();
      return;
    }

    const hasExtensions      = (baseId & 0x01) !== 0;
    const hasSubgroupObject  = (baseId & 0x02) !== 0;
    const hasSubgroup        = (baseId & 0x04) !== 0;
    const hasEnd             = (baseId & 0x08) !== 0;

    const trackAlias = await r.varint();
    const groupId    = await r.varint();
    const subGroupId = hasSubgroup ? await r.varint() : 0;
    const priority   = hasPriority ? await r.u8() : 128;

    console.log(`[MoQT] GROUP: type=0x${typeId.toString(16)} alias=${trackAlias} group=${groupId} subgroup=${subGroupId} priority=${priority}`);

    // Look up track by alias, or fall back to matching requestId
    let track = this.trackAliasMap.get(trackAlias);
    if (!track) {
      for (const [, info] of this.trackAliasMap) {
        if (info.requestId === trackAlias) { track = info; break; }
      }
    }
    if (!track) {
      console.warn(`[MoQT] GROUP for unknown alias=${trackAlias}, known aliases:`, [...this.trackAliasMap.keys()]);
      r.cancel();
      return;
    }

    // Read frames
    const flags = { hasExtensions, hasSubgroupObject, hasSubgroup, hasEnd };
    while (true) {
      const streamDone = await r.done();
      if (streamDone) break;

      // Read frame: id_delta + [extensions] + payload_length + payload/status
      const delta = await r.varint();
      if (delta !== 0) {
        console.warn(`[MoQT] Non-zero id_delta: ${delta}`);
      }

      if (hasExtensions) {
        const extLen = await r.varint();
        if (extLen > 0) await r.read(extLen);
      }

      const payloadLen = await r.varint();

      if (payloadLen > 0) {
        const payload = await r.read(payloadLen);
        this._onFrame(track, payload, groupId);
      } else {
        const status = await r.varint();
        if (hasEnd && status === 0) {
          // Empty frame, ignore
        } else if (status === 0 || status === GROUP_END_STATUS) {
          break; // End of group
        } else {
          console.warn(`[MoQT] Unsupported object status: ${status}`);
          break;
        }
      }
    }
  }

  // moq-lite-03 data streams: varint(DataType=0) + varint(size) + varint(subscribe_id) + varint(sequence) + [varint(size) + payload]...
  async _handleDataStreamLite3(r) {
    const dataType = await r.varint();
    if (dataType !== 0) {
      console.warn(`[MoQT] lite-03: unexpected DataType: ${dataType}`);
      r.cancel();
      return;
    }

    // Group is a Message — it has a size prefix before the body fields
    const groupSize   = await r.varint();  // size prefix (Group implements Message trait)
    const subscribeId = await r.varint();
    const groupSeq    = await r.varint();

    const track = this.trackAliasMap.get(subscribeId);
    if (!track) {
      console.warn(`[MoQT] lite-03: GROUP for unknown subscribe_id=${subscribeId}, known:`, [...this.trackAliasMap.keys()]);
      r.cancel();
      return;
    }

    console.log(`[MoQT] GROUP (lite-03): subscribe=${subscribeId} seq=${groupSeq} track="${track.name}"`);

    // Read frames: varint(size) + payload, until stream FIN
    while (true) {
      const streamDone = await r.done();
      if (streamDone) break;

      const frameSize = await r.varint();
      if (frameSize > 0) {
        const payload = await r.read(frameSize);
        this._onFrame(track, payload, groupSeq);
      }
    }
  }

  // --- Frame Handler ---

  _onFrame(trackInfo, payload, groupId) {
    if (!trackInfo) return;

    this.stats.framesReceived++;
    this.stats.bytesReceived += payload.byteLength;

    const name = trackInfo.name;

    // Catalog track
    if (name === 'catalog') {
      this._onCatalog(payload);
      return;
    }

    // Relay transport stats track
    if (name === 'relay-stats') {
      try {
        const text = new TextDecoder().decode(payload);
        this.relayStats = JSON.parse(text);
      } catch (e) { /* ignore malformed stats */ }
      return;
    }

    // First media frame timing
    if (!this.timing.firstMediaFrame) {
      this.timing.firstMediaFrame = performance.now();
    }

    // Determine media type from track name
    const type = trackInfo.type || (name.startsWith('video') ? 'video' : 'audio');

    // ABR transition: detect frames from new/old track during switch
    if (this._abrPendingSwitch && type === 'video') {
      const pending = this._abrPendingSwitch;
      if (name === pending.newTrack.name && window.hasMoof(payload)) {
        if (!pending.receivedFirstGroup) {
          pending.receivedFirstGroup = true;
          console.log(`[ABR] First moof from new track ${name}`);
          this._abrCompleteSwitch();
        }
      } else if (pending.receivedFirstGroup && name === pending.oldTrack?.name) {
        // Drop frames from old track after we've started receiving new track
        return;
      }
    }

    // Detect init segment (moov) vs media fragment (moof)
    if (window.hasMoov(payload)) {
      console.log(`[MoQT] Init segment: ${name} (${payload.byteLength}B) group=${groupId}`);
      // Parse timescale for latency-based fragment dropping
      const ts = window.parseTimescaleFromInit(payload);
      if (ts) {
        this._timescale[type] = ts;
        console.log(`[MoQT] ${type} timescale=${ts}`);
      }
      this.appender.setInitSegment(type, payload);
    } else if (window.hasMoof(payload)) {
      if (!this.timing.firstFragment) {
        this.timing.firstFragment = performance.now();
        this.timing.firstFragmentType = type;
      }
      // Latency-based fragment dropping: skip fragments too far behind the newest
      if (this._timescale[type] > 0) {
        const bdt = window.parseBDT(payload);
        if (bdt !== null) {
          if (bdt > this._latestBDT[type]) {
            this._latestBDT[type] = bdt;
          }
          const age = this._latestBDT[type] - bdt;
          const maxAge = (this.targetLatency * 1.5) * this._timescale[type] / 1000;
          if (age > maxAge) {
            this._droppedStale[type]++;
            if (this._droppedStale[type] <= 5 || this._droppedStale[type] % 50 === 0) {
              const ageMs = Math.round(age * 1000 / this._timescale[type]);
              console.log(`[Latency] Dropping stale ${type} fragment: ${ageMs}ms behind (dropped=${this._droppedStale[type]})`);
            }
            return;
          }
        }
      }
      this.appender.append(type, payload);
      // Trigger play immediately on first media append
      this._triggerPlay();
    } else {
      // Could be ftyp+moov or combined — try setting as init
      console.debug(`[MoQT] Unknown payload type: ${name} (${payload.byteLength}B)`);
      // Check if it has ftyp (common in init segments)
      if (payload.length > 8) {
        const boxType = String.fromCharCode(payload[4], payload[5], payload[6], payload[7]);
        if (boxType === 'ftyp') {
          this.appender.setInitSegment(type, payload);
        }
      }
    }
  }

  // --- Catalog Handler ---

  async _onCatalog(payload) {
    try {
      if (!this.timing.catalogReceived) {
        this.timing.catalogReceived = performance.now();
      }
      const text = new TextDecoder().decode(payload);
      const catalog = JSON.parse(text);
      console.log('[MoQT] Catalog received:', catalog);
      this.onCatalog(catalog);

      // On subsequent catalogs, check for changed init segments (ad insertion).
      // Only update tracks we're actually subscribed to.
      if (this.catalogReceived) {
        const tracks = catalog.tracks || [];
        for (const track of tracks) {
          if (!track.initData || !track.name) continue;
          if (!this._subscribedTracks || !this._subscribedTracks[track.name]) continue;
          const type = this._subscribedTracks[track.name];
          const newInitB64 = track.initData;
          if (this._lastInitData && this._lastInitData[type] !== newInitB64) {
            try {
              const initBytes = this._base64ToUint8Array(newInitB64);
              console.log(`[MoQT] Init CHANGED mid-stream: ${track.name} (${initBytes.byteLength}B)`);
              this.appender.setInitSegment(type, initBytes);
              this._lastInitData[type] = newInitB64;
            } catch (e) {
              console.warn(`[MoQT] Failed to update initData for ${track.name}:`, e);
            }
          }
        }
        return;
      }
      this.catalogReceived = true;
      this._lastInitData = {};
      this._subscribedTracks = {};

      const tracks = catalog.tracks || [];

      // Classify tracks into video, audio, and other
      const videoTracks = [];
      const audioTracks = [];
      for (const track of tracks) {
        if (!track.name) continue;
        const selParams = track.selectionParams || {};
        const mime = selParams.mimeType || '';
        if (mime.startsWith('audio') || track.name.includes('audio')) {
          audioTracks.push(track);
        } else if (mime.startsWith('video') || track.name.includes('video')) {
          videoTracks.push(track);
        } else {
          console.log(`[MoQT] Skipping non-media track: ${track.name}`);
        }
      }

      // Build ABR ladder — sort video tracks ascending by resolution
      this.abrLadder = videoTracks
        .map(t => ({ name: t.name, width: t.width || 0, height: t.height || 0, initData: t.initData }))
        .sort((a, b) => (a.width * a.height) - (b.width * b.height));

      // Select starting quality: medium (middle of ladder)
      const startIndex = this.abrLadder.length > 1
        ? Math.floor((this.abrLadder.length - 1) / 2)
        : 0;
      this.abrCurrentIndex = startIndex;
      const selectedVideo = this.abrLadder.length > 0
        ? videoTracks.find(t => t.name === this.abrLadder[startIndex].name)
        : null;
      const selectedAudio = audioTracks.length > 0 ? audioTracks[0] : null;

      // Read targetLatency from catalog (per-track field, use first video track's value)
      if (selectedVideo && selectedVideo.targetLatency) {
        this.targetLatency = selectedVideo.targetLatency;
      } else if (catalog.targetLatency) {
        this.targetLatency = catalog.targetLatency;
      }
      console.log(`[MoQT] Target latency: ${this.targetLatency}ms`);

      if (this.abrLadder.length > 1) {
        const ladder = this.abrLadder.map(t => `${t.height}p`).join(' < ');
        console.log(`[MoQT] ABR ladder: ${ladder}, starting at ${this.abrLadder[startIndex].height}p (index ${startIndex})`);
      }

      console.log(`[MoQT] Selected tracks: video=${selectedVideo?.name} audio=${selectedAudio?.name}`);
      this.onStatus(`Subscribing...`);

      // Extract init data for selected tracks
      if (selectedVideo?.initData) {
        try {
          const initBytes = this._base64ToUint8Array(selectedVideo.initData);
          console.log(`[MoQT] Init from catalog: ${selectedVideo.name} (${initBytes.byteLength}B)`);
          this.appender.setInitSegment('video', initBytes);
          this._lastInitData['video'] = selectedVideo.initData;
        } catch (e) {
          console.warn(`[MoQT] Failed to decode initData for ${selectedVideo.name}:`, e);
        }
      }
      if (selectedAudio?.initData) {
        try {
          const initBytes = this._base64ToUint8Array(selectedAudio.initData);
          console.log(`[MoQT] Init from catalog: ${selectedAudio.name} (${initBytes.byteLength}B)`);
          this.appender.setInitSegment('audio', initBytes);
          this._lastInitData['audio'] = selectedAudio.initData;
        } catch (e) {
          console.warn(`[MoQT] Failed to decode initData for ${selectedAudio.name}:`, e);
        }
      }

      // Subscribe to selected video and audio
      this.timing.subscribeStart = performance.now();

      if (selectedVideo) {
        this._subscribedTracks[selectedVideo.name] = 'video';
        try {
          const alias = await this._subscribe(selectedVideo.name, 128);
          const info = this.trackAliasMap.get(alias);
          if (info) info.type = 'video';
          this.abrActiveTrack = {
            name: selectedVideo.name,
            alias,
            requestId: info?.requestId ?? (this.nextReqId - 2),
          };
        } catch (e) {
          console.error(`[MoQT] Failed to subscribe to ${selectedVideo.name}:`, e);
        }
      }

      if (selectedAudio) {
        this._subscribedTracks[selectedAudio.name] = 'audio';
        try {
          const alias = await this._subscribe(selectedAudio.name, 64);
          const info = this.trackAliasMap.get(alias);
          if (info) info.type = 'audio';
        } catch (e) {
          console.error(`[MoQT] Failed to subscribe to ${selectedAudio.name}:`, e);
        }
      }

      // Subscribe to relay-stats (non-fatal — older relays won't have it)
      try {
        const statsAlias = await this._subscribe('relay-stats', 32);
        const statsInfo = this.trackAliasMap.get(statsAlias);
        if (statsInfo) statsInfo.type = 'relay-stats';
      } catch (e) {
        console.warn('[MoQT] relay-stats not available:', e.message);
      }

      this.timing.subscribeDone = performance.now();
      this.abrState = 'stable';
      this.abrStableStart = Date.now();
      this._startAbrMonitor();

      this.onStatus('Playing');
    } catch (e) {
      console.error('[MoQT] Catalog parse error:', e);
    }
  }

  // --- ABR ---

  _startAbrMonitor() {
    if (this.abrLadder.length <= 1) return;
    this._abrInterval = setInterval(() => this._abrEvaluate(), 1000);
  }

  _abrEvaluate() {
    if (this.abrSwitching) return;

    // Grace period: skip evaluation until 5s after first decode to let buffer stabilize
    if (!this.timing.firstFrameDecoded || (performance.now() - this.timing.firstFrameDecoded) < 5000) return;

    const video = this.video;
    const buffered = video.buffered;
    const bufferHealth = buffered.length > 0
      ? buffered.end(buffered.length - 1) - video.currentTime
      : 0;

    const dropped = video.getVideoPlaybackQuality?.()?.droppedVideoFrames || 0;
    const droppedDelta = dropped - this.abrLastDroppedFrames;
    this.abrLastDroppedFrames = dropped;

    // ABR thresholds relative to target latency
    const targetSec = this.targetLatency / 1000;
    const downThreshold = Math.max(targetSec * 0.3, 0.15);   // switch down if buffer low
    const upThreshold = Math.max(targetSec * 1.5, 1.0);     // switch up if buffer healthy

    // Switch DOWN: buffer critically low or excessive dropped frames
    if ((bufferHealth < downThreshold || droppedDelta > 5) && this.abrCurrentIndex > 0) {
      console.log(`[ABR] Switch DOWN: buffer=${bufferHealth.toFixed(2)}s (threshold=${downThreshold.toFixed(2)}s) dropped=${droppedDelta} → ${this.abrLadder[this.abrCurrentIndex - 1].height}p`);
      this._abrSwitchTo(this.abrCurrentIndex - 1);
      this._relayDeficitCount = 0;
      return;
    }

    // Relay-assisted early DOWN: send throughput < 70% of receive rate for 2+ seconds.
    // The relay is receiving more data than it can deliver to this subscriber.
    if (this.relayStats && this.abrCurrentIndex > 0) {
      const recv = this.relayStats.receive_rate_mbps;
      const send = this.relayStats.send_throughput_mbps;
      if (recv > 0 && send > 0 && send < recv * 0.7) {
        this._relayDeficitCount = (this._relayDeficitCount || 0) + 1;
        if (this._relayDeficitCount >= 2) {
          console.log(`[ABR] Relay deficit DOWN: recv=${recv.toFixed(1)} send=${send.toFixed(1)} Mbps (${this._relayDeficitCount}s) → ${this.abrLadder[this.abrCurrentIndex - 1].height}p`);
          this._abrSwitchTo(this.abrCurrentIndex - 1);
          this._relayDeficitCount = 0;
          return;
        }
      } else {
        this._relayDeficitCount = 0;
      }
    }

    // Switch UP: sustained healthy buffer for 10+ seconds
    if (bufferHealth > upThreshold && this.abrCurrentIndex < this.abrLadder.length - 1) {
      if (this.abrState !== 'stable') {
        this.abrState = 'stable';
        this.abrStableStart = Date.now();
      } else if (Date.now() - this.abrStableStart > 5000) {
        console.log(`[ABR] Switch UP: buffer=${bufferHealth.toFixed(2)}s (threshold=${upThreshold.toFixed(2)}s) stable=${((Date.now() - this.abrStableStart) / 1000).toFixed(0)}s → ${this.abrLadder[this.abrCurrentIndex + 1].height}p`);
        this._abrSwitchTo(this.abrCurrentIndex + 1);
        return;
      }
    } else {
      // Reset stable timer if buffer drops below up threshold
      if (this.abrState === 'stable' && bufferHealth <= upThreshold) {
        this.abrStableStart = Date.now();
      }
    }
  }

  async _abrSwitchTo(newIndex) {
    if (newIndex < 0 || newIndex >= this.abrLadder.length) return;
    if (this.abrSwitching) return;

    this.abrSwitching = true;
    this.abrState = 'switching';
    const oldTrack = this.abrActiveTrack;
    const newTrackInfo = this.abrLadder[newIndex];

    console.log(`[ABR] Switching: ${this.abrLadder[this.abrCurrentIndex].height}p → ${newTrackInfo.height}p`);

    // Pre-load new track's init segment from catalog
    if (newTrackInfo.initData) {
      try {
        const initBytes = this._base64ToUint8Array(newTrackInfo.initData);
        this.appender.setInitSegment('video', initBytes);
        console.log(`[ABR] Pre-loaded init for ${newTrackInfo.name} (${initBytes.byteLength}B)`);
      } catch (e) {
        console.warn(`[ABR] Failed to pre-load init:`, e);
      }
    }

    // Subscribe to new track
    try {
      this._subscribedTracks[newTrackInfo.name] = 'video';
      const alias = await this._subscribe(newTrackInfo.name, 128);
      const info = this.trackAliasMap.get(alias);
      if (info) info.type = 'video';

      this._abrPendingSwitch = {
        oldTrack,
        newTrack: { name: newTrackInfo.name, alias, requestId: info?.requestId ?? (this.nextReqId - 2) },
        newIndex,
        receivedFirstGroup: false,
      };

      // Timeout — abort if no data from new track within 5s
      this._abrSwitchTimeout = setTimeout(() => {
        if (this._abrPendingSwitch) {
          console.warn(`[ABR] Switch timeout — aborting`);
          this._abrAbortSwitch();
        }
      }, 5000);

    } catch (e) {
      console.error(`[ABR] Subscribe failed for ${newTrackInfo.name}:`, e);
      this.abrSwitching = false;
      this.abrState = 'stable';
    }
  }

  async _abrCompleteSwitch() {
    const pending = this._abrPendingSwitch;
    if (!pending) return;

    clearTimeout(this._abrSwitchTimeout);

    // Unsubscribe old track
    if (pending.oldTrack) {
      try {
        await this._unsubscribe(pending.oldTrack.requestId);
        delete this._subscribedTracks[pending.oldTrack.name];
        console.log(`[ABR] Unsubscribed old track: ${pending.oldTrack.name}`);
      } catch (e) {
        console.warn(`[ABR] Failed to unsubscribe old track:`, e);
      }
    }

    // Update active track
    this.abrActiveTrack = pending.newTrack;
    this.abrCurrentIndex = pending.newIndex;
    this.abrSwitchCount++;
    this.abrSwitching = false;
    this.abrState = 'stable';
    this.abrStableStart = Date.now();
    this._abrPendingSwitch = null;

    console.log(`[ABR] Switch complete → ${this.abrLadder[this.abrCurrentIndex].height}p (${this.abrSwitchCount} switches total)`);
  }

  async _abrAbortSwitch() {
    const pending = this._abrPendingSwitch;
    if (!pending) return;

    clearTimeout(this._abrSwitchTimeout);

    // Unsubscribe the new track we tried
    try {
      await this._unsubscribe(pending.newTrack.requestId);
      delete this._subscribedTracks[pending.newTrack.name];
    } catch (e) {
      console.warn(`[ABR] Failed to unsubscribe new track on abort:`, e);
    }

    // Re-load old init segment
    const oldInfo = this.abrLadder[this.abrCurrentIndex];
    if (oldInfo?.initData) {
      try {
        const initBytes = this._base64ToUint8Array(oldInfo.initData);
        this.appender.setInitSegment('video', initBytes);
      } catch (e) { /* ignore */ }
    }

    this.abrSwitching = false;
    this.abrState = 'stable';
    this.abrStableStart = Date.now();
    this._abrPendingSwitch = null;
    console.log(`[ABR] Switch aborted — staying on ${this.abrLadder[this.abrCurrentIndex].height}p`);
  }

  _base64ToUint8Array(b64) {
    const binaryString = atob(b64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  // --- Buffer Trimming ---
  /*! Copyright © 2026 Erik Herz. All rights reserved. — Buffer Trimming */
  _trimLoop() {
    setInterval(() => {
      if (this.video.currentTime > 0) {
        this.appender.trimBuffer(this.video.currentTime, 3);
      }
    }, 1000);
  }

  // --- Live-Edge Seeking ---
  /*! Copyright © 2026 Erik Herz. All rights reserved. — Latency Control */
  _seekLoop() {
    setInterval(() => {
      if (this.video.paused) return;
      const b = this.video.buffered;
      if (b.length === 0) return;

      const edge = b.end(b.length - 1);
      const bufStart = b.start(0);
      const targetSec = this.targetLatency / 1000;
      let target = edge - targetSec;

      // Clamp: never seek before buffer start or past buffer end
      if (target < bufStart) target = bufStart;
      if (target > edge - 0.05) target = edge - 0.05;

      const drift = target - this.video.currentTime;

      // Seek if drifted more than 200ms in either direction
      if (drift > 0.2 || drift < -0.2) {
        console.log(`[Latency] Seeking: drift=${drift > 0 ? '+' : ''}${drift.toFixed(2)}s edge=${edge.toFixed(2)}s buf=${(edge - bufStart).toFixed(2)}s`);
        this.video.currentTime = target;
      }
    }, 200);
  }

  /** Get the live edge — use video buffer (what's actually decodable),
   *  fall back to audio if video hasn't arrived yet. */
  /*! Copyright © 2026 Erik Herz. All rights reserved. — Live Edge Management */
  _getLiveEdge() {
    const videoSb = this.appender.sourceBuffers.video;
    if (videoSb && videoSb.buffered.length > 0) {
      return videoSb.buffered.end(videoSb.buffered.length - 1);
    }
    // Fallback to audio only when video has no data yet
    const audioSb = this.appender.sourceBuffers.audio;
    if (audioSb && audioSb.buffered.length > 0) {
      return audioSb.buffered.end(audioSb.buffered.length - 1);
    }
    const b = this.video.buffered;
    return b.length > 0 ? b.end(b.length - 1) : 0;
  }

  // --- Play trigger ---
  /*! Copyright © 2026 Erik Herz. All rights reserved. — Auto-Seek to Live Edge */
  _triggerPlay() {
    if (this._playTriggered) return;
    this._playTriggered = true;

    // Seek to buffered start so Chrome transitions to HAVE_CURRENT_DATA immediately.
    // Without this, currentTime=0 but data starts at the live edge (e.g. 52s),
    // so Chrome stays at HAVE_METADATA until enough data accumulates.
    const seekToBuffered = () => {
      const b = this.video.buffered;
      if (b.length > 0 && this.video.currentTime < b.start(0)) {
        const target = b.start(0);
        console.log(`[MoQT] Seeking to buffered start: ${target.toFixed(3)}s`);
        this.video.currentTime = target;
      }
    };

    // Try immediately, and also after a short delay for the append to land
    seekToBuffered();
    setTimeout(seekToBuffered, 10);
    setTimeout(seekToBuffered, 50);

    this.video.play().catch(e => {
      console.warn('[MoQT] play() rejected:', e.message);
    });
  }

  _initialSeek() {
    if (this._initialSeekDone) return;
    this._initialSeekDone = true;
    const edge = this._getLiveEdge();
    if (edge > 0.15) {
      const target = edge - 0.05; // 50ms behind live edge
      console.log(`[MoQT] Initial seek: edge=${edge.toFixed(3)}s → ${target.toFixed(3)}s`);
      this.video.currentTime = target;
    }
  }

  // --- Timing ---

  _logTiming() {
    const t = this.timing;
    const t0 = t.connectStart || 0;
    const fmt = (label, ts) => ts ? `${label}: ${(ts - t0).toFixed(0)}ms` : null;
    const delta = (label, from, to) => (from && to) ? `${label}: +${(to - from).toFixed(0)}ms` : null;
    const lines = [
      fmt('QUIC connect',      t.connectDone),
      fmt('MSE sourceopen',    t.mseOpen),
      fmt('SETUP done',        t.setupDone),
      fmt('Catalog SUB sent',  t.catalogSubSent),
      fmt('Catalog SUB_OK',    t.catalogSubOk),
      fmt('Catalog data',      t.catalogReceived),
      fmt('Media SUBs done',   t.subscribeDone),
      fmt('First media frame', t.firstMediaFrame),
      fmt('First fragment',    t.firstFragment),
      fmt('Video appended',    t.firstVideoAppend),
      t.firstFragment ? `  (${t.firstFragmentType})` : null,
      fmt('First decoded',     t.firstFrameDecoded),
      fmt('First blit',        t.firstBlit),
      '',
      delta('  Connect→SETUP',      t.connectDone, t.setupDone),
      delta('  SETUP→Catalog data',  t.setupDone, t.catalogReceived),
      delta('  Catalog→Subscribes', t.catalogReceived, t.subscribeDone),
      delta('  Subscribe→Fragment',  t.subscribeDone, t.firstFragment),
      delta('  Fragment→Decoded',    t.firstFragment, t.firstFrameDecoded),
      delta('  Decoded→Blit',        t.firstFrameDecoded, t.firstBlit),
      `  Video appends before decode: ${this._videoAppends.length}`,
    ].filter(Boolean);
    console.log(`[MoQT] ⏱ Pipeline timing:\n  ${lines.join('\n  ')}`);
  }

  getTiming() {
    const t = this.timing;
    const t0 = t.connectStart || 0;
    const rel = (ts) => ts ? Math.round(ts - t0) : null;
    return {
      connectMs:       rel(t.connectDone),
      mseOpenMs:       rel(t.mseOpen),
      setupMs:         rel(t.setupDone),
      catalogSubMs:    rel(t.catalogSubSent),
      catalogOkMs:     rel(t.catalogSubOk),
      catalogMs:       rel(t.catalogReceived),
      subscribeMs:     rel(t.subscribeDone),
      firstMediaMs:    rel(t.firstMediaFrame),
      firstFragmentMs: rel(t.firstFragment),
      videoAppendMs:   rel(t.firstVideoAppend),
      appendsBeforeDecode: this._videoAppends.length,
      firstDecodedMs:  rel(t.firstFrameDecoded),
      firstBlitMs:     rel(t.firstBlit),
    };
  }

  // --- Stats ---

  getStats() {
    const b = this.video.buffered;
    const edge = b.length > 0 ? b.end(b.length - 1) : 0;
    const bufferHealth = edge - this.video.currentTime;
    return {
      framesReceived: this.stats.framesReceived,
      bytesReceived: this.stats.bytesReceived,
      bufferHealth: bufferHealth.toFixed(2),
      currentTime: this.video.currentTime.toFixed(2),
      uptime: Math.floor((Date.now() - this.stats.startTime) / 1000),
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      abrState: this.abrState,
      abrCurrentTrack: this.abrActiveTrack?.name || '',
      abrCurrentResolution: this.abrCurrentIndex >= 0 && this.abrLadder[this.abrCurrentIndex]
        ? `${this.abrLadder[this.abrCurrentIndex].height}p`
        : '',
      abrCurrentIndex: this.abrCurrentIndex,
      abrLadderSize: this.abrLadder.length,
      abrSwitchCount: this.abrSwitchCount,
      abrLadder: this.abrLadder.map(t => `${t.height}p`).join(', '),
      targetLatency: this.targetLatency,
      droppedStaleVideo: this._droppedStale.video,
      droppedStaleAudio: this._droppedStale.audio,
      relayRtt: this.relayStats?.rtt_ms,
      relaySendRate: this.relayStats?.send_rate_mbps,
      relaySendThroughput: this.relayStats?.send_throughput_mbps,
      relayReceiveRate: this.relayStats?.receive_rate_mbps,
      relayPacketsLost: this.relayStats?.packets_lost,
      relayVersion: this.relayStats?.version,
    };
  }

  // --- Cleanup ---

  destroy() {
    if (this._abrInterval) clearInterval(this._abrInterval);
    this.appender.destroy();
    if (this.wt) {
      try { this.wt.close(); } catch (e) { /* ignore */ }
    }
  }
}

// Expose to window
window.MoqtPlayer = MoqtPlayer;
