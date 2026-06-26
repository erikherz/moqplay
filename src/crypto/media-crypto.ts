// Relay-blind end-to-end media encryption (AES-GCM per encoded chunk).
//
// GOAL: the CDN relay (tinymoq) forwards only ciphertext it cannot read. The
// access JWT gates the *connection*; this content key gates *decryption*. They
// layer — even the relay operator, or an unauthorized connection, sees only
// opaque bytes. This is NOT DRM: an authorized viewer can still capture decoded
// frames. See PER-BROADCAST-TOKENS.md / stream-security.md §7 for scope.
//
// HOW IT HOOKS IN (no public @moq API exists, so we patch the library at build
// time — see vite.config.ts `mediaCryptoPatch`, same mechanism as the existing
// `moqWebTransportOnly` patch). The legacy container frame on the wire is:
//     [varint timestamp][raw codec payload]
// We keep the varint in the clear (the container reads it, and we bind it as
// AES-GCM additional-authenticated-data) and encrypt only the payload:
//     [varint timestamp][12-byte nonce][AES-GCM ciphertext + 16-byte tag]
// MoQ object/group framing is untouched, so the relay still routes groups and
// keyframe boundaries exactly as before. The catalog (codec config / SPS-PPS)
// travels via writeJson, NOT through these seams, so it stays in the clear by
// design (decision: leak codec/resolution metadata, never content).
//
// The patched library code reaches us through a page-scoped global
// (`globalThis.__VIVOH_MEDIA_CRYPTO__`) that we install when a key is
// provisioned. The global is never exposed to the relay (the relay never runs
// our JS). When no key is armed, the global is absent and the library behaves
// byte-for-byte as upstream (passthrough).
//
// NONCE: a fresh 12-byte random nonce per chunk, carried in the frame. The
// publisher is the sole encryptor (the relay fans out identical ciphertext to
// every viewer — that is what preserves MoQ single-encode fan-out), so nonce
// uniqueness is a single-writer problem; random 96-bit nonces are safe well
// past our per-session frame counts and need no cross-track / cross-reconnect
// coordination (the failure mode of counters). The GCM auth tag additionally
// gives integrity for free: a tampering/injecting relay fails decryption.

const ALGO = "AES-GCM";
const NONCE_BYTES = 12;

type Mode = "publisher" | "viewer";

// --- module state (one role per page: a broadcast page OR a watch page) ------
let mode: Mode | null = null;
let armed = false; // we KNOW this stream is encrypted; encrypt/decrypt is live
let key: CryptoKey | null = null;
// Frames can be produced before the key arrives (encoder warms up while the
// /assign + key fetch is in flight). We arm encryption immediately and make the
// per-frame work await this promise, so nothing is ever published in the clear.
let keyReady: Promise<void> = Promise.resolve();
let keyReadyResolve: (() => void) | null = null;

function resetKeyReady(): void {
  keyReady = new Promise<void>((resolve) => {
    keyReadyResolve = resolve;
  });
}

// QUIC varint length from the first byte (RFC 9000 §16: top 2 bits select 1/2/4/8).
function varintLen(first: number): number {
  return 1 << ((first & 0xc0) >> 6);
}

function b64urlToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function encryptFrame(frame: Uint8Array): Promise<Uint8Array> {
  await keyReady;
  if (!key) throw new Error("media-crypto: encrypt with no key");
  const vlen = varintLen(frame[0]);
  const ts = frame.subarray(0, vlen); // cleartext timestamp + AAD
  const payload = frame.subarray(vlen);
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGO, iv: nonce, additionalData: ts }, key, payload)
  );
  const out = new Uint8Array(vlen + NONCE_BYTES + ct.byteLength);
  out.set(ts, 0);
  out.set(nonce, vlen);
  out.set(ct, vlen + NONCE_BYTES);
  return out;
}

async function decryptFrame(frame: Uint8Array): Promise<Uint8Array> {
  await keyReady;
  if (!key) throw new Error("media-crypto: decrypt with no key");
  const vlen = varintLen(frame[0]);
  const ts = frame.subarray(0, vlen);
  const nonce = frame.subarray(vlen, vlen + NONCE_BYTES);
  const ct = frame.subarray(vlen + NONCE_BYTES);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt({ name: ALGO, iv: nonce, additionalData: ts }, key, ct)
  );
  const out = new Uint8Array(vlen + pt.byteLength);
  out.set(ts, 0);
  out.set(pt, vlen);
  return out;
}

// Per-group ordering: AES-GCM is async, but frames within a group must stay in
// order. Each group gets a promise chain so writes serialize even though the
// encoder calls writeFrame synchronously and doesn't await us.
const chains = new WeakMap<object, Promise<unknown>>();
function chain(group: object, task: () => Promise<void>): void {
  const prev = chains.get(group) ?? Promise.resolve();
  const next = prev.then(task).catch((e) => {
    console.error("[media-crypto] frame task failed (frame dropped):", e);
  });
  chains.set(group, next);
}

interface GroupLike {
  writeFrame(frame: Uint8Array): void;
  close(): void;
}

// Installed onto globalThis for the build-time library patch to call.
interface MediaCryptoHooks {
  shouldEncrypt(trackName?: string): boolean;
  shouldDecrypt(): boolean;
  // video path: many frames per group, group rotates on keyframe
  write(group: GroupLike, frame: Uint8Array): void;
  closeGroup(group: GroupLike): void; // chained close so pending writes flush first
  // audio path: one group per frame (Track.writeFrame), closed immediately
  writeAndClose(group: GroupLike, frame: Uint8Array): void;
  beforeDecode(frame: Uint8Array): Promise<Uint8Array>;
}

function install(): void {
  const hooks: MediaCryptoHooks = {
    shouldEncrypt: () => mode === "publisher" && armed,
    shouldDecrypt: () => mode === "viewer" && armed,
    write(group, frame) {
      chain(group, async () => {
        const enc = await encryptFrame(frame);
        try {
          group.writeFrame(enc);
        } catch {
          /* group already closed — drop */
        }
      });
    },
    closeGroup(group) {
      chain(group, async () => {
        try {
          group.close();
        } catch {
          /* already closed */
        }
      });
    },
    writeAndClose(group, frame) {
      chain(group, async () => {
        try {
          const enc = await encryptFrame(frame);
          group.writeFrame(enc);
        } catch {
          /* drop */
        } finally {
          try {
            group.close();
          } catch {
            /* already closed */
          }
        }
      });
    },
    beforeDecode: (frame) => decryptFrame(frame),
  };
  (globalThis as unknown as { __VIVOH_MEDIA_CRYPTO__?: MediaCryptoHooks }).__VIVOH_MEDIA_CRYPTO__ =
    hooks;
}

// --- public API (used by src/main.ts) ----------------------------------------

/**
 * Arm publisher-side encryption BEFORE going live. Call as soon as the stream
 * is known to be encrypted (from its settings), even before the content key has
 * been fetched — frames produced in the meantime queue until {@link setMediaKey}.
 */
export function armPublisher(): void {
  if (mode === "publisher" && armed) return; // already armed — keep the pending keyReady
  mode = "publisher";
  armed = true;
  key = null;
  resetKeyReady();
  install();
}

/** Arm viewer-side decryption BEFORE connecting to the relay. */
export function armViewer(): void {
  if (mode === "viewer" && armed) return; // already armed
  mode = "viewer";
  armed = true;
  key = null;
  resetKeyReady();
  install();
}

/**
 * Drop the current key WITHOUT un-arming (e.g. between broadcasts on the same
 * page). Subsequent frames queue until the next {@link setMediaKey} so a new
 * broadcast's frames are never encrypted with the previous session's key.
 */
export function resetMediaKey(): void {
  if (!armed) return;
  key = null;
  resetKeyReady();
}

/** Import the per-broadcast content key (base64url, 256-bit) and release queued frames. */
export async function setMediaKey(b64url: string): Promise<void> {
  const raw = b64urlToBytes(b64url);
  key = await crypto.subtle.importKey("raw", raw, { name: ALGO }, false, ["encrypt", "decrypt"]);
  keyReadyResolve?.();
}

/** Tear down: clears the key and removes the global so the library reverts to passthrough. */
export function clearMediaCrypto(): void {
  mode = null;
  armed = false;
  key = null;
  keyReadyResolve?.(); // unblock any awaiters so they don't hang
  keyReady = Promise.resolve();
  keyReadyResolve = null;
  delete (globalThis as unknown as { __VIVOH_MEDIA_CRYPTO__?: MediaCryptoHooks })
    .__VIVOH_MEDIA_CRYPTO__;
}
