# Relay-Blind End-to-End Media Encryption

**Status:** live in production (per-stream opt-in, default off).
**Scope:** browser publisher ⇄ Cloudflare Worker ⇄ browser viewer. **No relay change** — TinyMoQ is intentionally kept ignorant and forwards only ciphertext.

This document explains the design, the exact integration points, the cryptographic
contract, and the limitations. It is the companion to
[`PER-BROADCAST-TOKENS.md`](./PER-BROADCAST-TOKENS.md) (relay access tokens).

---

## 1. What it is (and isn't)

Earthseed encrypts the **encoded media payload** in the browser before it is
published, and decrypts it in the browser after it is received. The CDN relay
(TinyMoQ) routes MoQ objects/groups exactly as before, but the payload bytes
inside are ciphertext it cannot read.

Two independent layers protect a stream; they compose:

| Layer | Secret | Gates | Defined in |
|-------|--------|-------|-----------|
| **Access** | per-broadcast HS256 **JWT** | the *connection* to the relay | `PER-BROADCAST-TOKENS.md` |
| **Confidentiality** | per-broadcast **content key** (AES-256) | *decryption* of the media | this document |

Because they layer, even an unauthorized connection — or the relay operator
themselves — gets only ciphertext.

**This delivers:** encrypted transport + relay-blind content confidentiality +
access control. Combined with our BYOK relay signing keys, we can truthfully say:
*TinyMoQ holds no keys to our streams and cannot see our content — it moves
encrypted bytes it can't read, and only people we authorize can decrypt them.*

**This is NOT:**
- **DRM / anti-screen-capture.** An authorized viewer holds the key and can still
  capture decoded frames. We do not claim otherwise.
- **Forward-secret or revocable in v1.** See [§9](#9-limitations--v2).

---

## 2. Threat model

| Adversary | Outcome |
|-----------|---------|
| The relay operator / a compromised relay | Sees only ciphertext + routing metadata (track names, group/keyframe boundaries, timing, sizes). Cannot recover media. |
| A network observer | Same as the relay (traffic is already QUIC/TLS to the relay; the payload is *additionally* encrypted). |
| A tampering/injecting relay | Detected. AES-GCM's auth tag fails on any modified byte, so forged/altered frames are dropped on decrypt. |
| An unauthorized viewer (no key) | Can connect (if not auth-gated) but receives undecryptable bytes → no playback (fail-closed). |
| A *formerly* authorized viewer who kept the key | **Can still decrypt** (v1 limitation — static per-session key). |

What the relay still learns (deliberately, so it can route): track names
(`video/hd`, `audio/...`, `catalog.json`), group/keyframe structure, frame sizes
and timing, and the codec/resolution **metadata** in the cleartext catalog
([§6](#6-what-stays-in-the-clear-and-why)).

---

## 3. Architecture at a glance

```
PUBLISHER (browser)                  RELAY (TinyMoQ)            VIEWER (browser)
─────────────────────                ───────────────           ─────────────────
WebCodecs encode                                               WebCodecs decode
   │  EncodedChunk                                                ▲  EncodedChunk
   ▼                                                              │
encodeFrame → [varint ts][payload]                       [varint ts][payload]
   │                                                              ▲
   ▼  AES-GCM encrypt payload                          AES-GCM decrypt │
[varint ts][nonce][ciphertext+tag] ──MoQ──▶ forwards ──MoQ──▶ [varint ts][nonce][ct+tag]
                                     opaque bytes
   ▲                                                              ▲
   └── content key (from go-live response)      content key (from /route, auth-gated)
                         │                                  │
                         └──────── Cloudflare Worker ───────┘
                          generates + stores + distributes
                          the per-broadcast content key (never to the relay)
```

The content key never touches the relay. It is generated server-side and handed
to authorized browser endpoints over TLS, alongside the existing token flow.

---

## 4. The cryptographic contract

### Frame format

The MoQ "legacy" container frame is, upstream:

```
[varint timestamp][raw codec payload]
```

Under encryption it becomes:

```
[varint timestamp][12-byte nonce][AES-GCM ciphertext + 16-byte tag]
```

- **Algorithm:** AES-256-GCM via WebCrypto (`crypto.subtle`, hardware-accelerated).
- **Key:** 256-bit, one per broadcast session, shared by the publisher and all
  admitted viewers (NOT per-viewer — the relay must fan out *identical* ciphertext
  to everyone, which is exactly what preserves MoQ's single-encode fan-out).
- **The varint timestamp stays in the clear.** The container needs it to order
  frames, and the relay is unaffected. It is also bound as additional
  authenticated data (AAD), so a relay cannot swap or replay framing without
  failing the tag.
- **Per-frame overhead:** 28 bytes (12 nonce + 16 tag).
- **MoQ framing is untouched** — only the payload is replaced — so the relay still
  does group/object routing and keyframe boundaries exactly as before. Keyframes
  need no special handling: each frame is encrypted independently, so `key`/`delta`
  typing is preserved verbatim.

### Nonce uniqueness (non-negotiable for GCM)

A fresh **12-byte random nonce per chunk**, carried in the frame.

The publisher is the **sole encryptor** (the relay fans out identical ciphertext),
so nonce uniqueness is a single-writer problem. A random 96-bit nonce is safe far
beyond our per-session frame counts (a 12-hour session at ~60 frames/s across both
tracks is ~2.6M frames — far below the birthday bound for random 96-bit nonces
under one key) and — unlike a counter — needs **no** coordination across tracks or
across reconnects (a reset counter under the same key would be catastrophic). The
nonce is generated with `crypto.getRandomValues`.

### Integrity (free)

The GCM authentication tag gives integrity for nothing: any tampered, injected, or
truncated ciphertext fails the tag check and the frame is dropped. A relay that
modifies bytes is detected on decrypt.

---

## 5. Where it hooks into the code

There is **no public API** in `@moq/publish` / `@moq/watch` to touch the encoded
chunk bytes — the encode→publish and receive→decode paths are sealed inside the
web components. So, exactly like the existing `moqWebTransportOnly` patch, we
**patch the dependency at build time** (`vite.config.ts` → `mediaCryptoPatch()`).

Three seams, all in **readable (non-minified)** `@moq` source:

| # | Seam | File | Role |
|---|------|------|------|
| 1 | `Producer.encode` | `@moq/hang/container/legacy.js` | **encrypt video** (video publishes through `Legacy.Producer` → `group.writeFrame`) |
| 2 | `Track.writeFrame` | `@moq/net/.../track.js` | **encrypt audio** (audio publishes one group per frame via `Track.writeFrame`) |
| 3 | before `Format.decode` | `@moq/hang/container/consumer.js` | **decrypt** (the single media read site for both tracks) |

Why these and not `Group.writeFrame`/`readFrame`? Because those are shared by the
wire pump — on publish the network *reads* via `readFrame`, on receive it *writes*
via `writeFrame` — so patching them would cancel out on send and double-encrypt on
receive. The three seams above are unambiguously on the application side of the
network boundary, and they are media-only (the catalog uses `writeJson`, a
different path).

Each seam routes through a page-scoped global, `globalThis.__VIVOH_MEDIA_CRYPTO__`,
installed by `src/crypto/media-crypto.ts` **only when a key is armed**. With nothing
armed the global is absent and every seam is byte-for-byte upstream behavior
(passthrough). The relay never runs our JS, so the global is never exposed to it.

### Fail-closed build

`mediaCryptoPatch()`'s `buildEnd` **throws if any of the three seams did not patch**
(verified output: `patched video=1 audio=4 decrypt=1`). A future `@moq` upgrade that
changes these source strings fails the build loudly rather than silently shipping a
build with an unencrypted media path.

### Async correctness

WebCrypto is asynchronous, but frames within a group must stay ordered and the
encoder calls `writeFrame` synchronously. `media-crypto.ts` keeps a **per-group
promise chain** so encryption serializes without the caller awaiting. It also
**arms before the key arrives**: encryption is switched on at page load (as soon as
the stream is known to be encrypted), and per-frame work `await`s a `keyReady`
promise, so any frame produced during encoder warmup *queues* rather than leaking
in the clear. On a keyframe the old group's close is also chained, so pending
encrypted writes flush before the group closes.

---

## 6. What stays in the clear, and why

The decoder configuration — codec string, dimensions, framerate, and the H.264
`description` (SPS/PPS) — lives in the **`catalog.json` track**, which is published
via `writeJson` and is therefore visible to the relay.

**v1 decision: leave the catalog in the clear.** It leaks codec/resolution
*metadata*, not content, and it keeps the watch library's JSON catalog parsing
untouched. This matches the honest scope ("relay-blind *content*", not "relay-blind
*metadata*"). Encrypting it (delivering `description` via the key channel instead)
is possible but deferred to v2.

---

## 7. Key generation, storage, and distribution

The Cloudflare Worker owns the content key. It is a **separate secret** from the
relay JWT-signing key (`MOQ_AUTH_K` / per-stream `relay.key`) and is **never** sent
to the relay or put on a connection URL.

### Generation & storage (publisher go-live)

`POST /api/stats/broadcast` (`src/worker/index.ts`):

1. If the stream's `streams.encrypted` flag is set, generate a fresh 256-bit key
   (`generateContentKey()` → `crypto.getRandomValues` → unpadded base64url).
2. Store it on the broadcast row: `broadcast_events.content_key`.
3. Return `{ ..., encrypted: true, content_key }` to the publisher.

One key per broadcast session; a new broadcast (even same stream id) gets a new key.

### Distribution (viewer)

`GET /api/streams/:id/route`:

- Reads `content_key` from the live broadcast row.
- **Auth gating:** if `streams.require_auth` is set, the key is returned **only** to
  a signed-in caller (an unauthorized viewer can still connect but, lacking the key,
  only ever sees ciphertext → fail-closed). For non-auth encrypted streams the key
  is returned to anyone (those streams are not meant to be private; encryption there
  only blinds the relay).
- Returns `{ relay, jwt, encrypted, content_key }`.

The content key is **per-broadcast and relay-independent**, so it survives any relay
change (reap/respawn, cross-cluster edge) in the viewer's refresh loop without being
re-fetched.

### Schema

Migration `0005_add_media_encryption.sql`:
- `streams.encrypted INTEGER DEFAULT 0` — per-stream opt-in.
- `broadcast_events.content_key TEXT` — the per-broadcast key (NULL when not encrypted).

---

## 8. Client wiring & UX

`src/crypto/media-crypto.ts` public API:

| Function | Used by | Effect |
|----------|---------|--------|
| `armPublisher()` | broadcast view, at page load | mode = publisher, install global, create pending `keyReady` (idempotent) |
| `armViewer()` | watch view, before connecting | mode = viewer, install global |
| `setMediaKey(b64url)` | both, when the key arrives | import the AES key, resolve `keyReady` (releases queued frames) |
| `resetMediaKey()` | broadcast end | drop the key but stay armed (next broadcast re-keys; frames queue until then) |
| `clearMediaCrypto()` | encryption toggled off | remove the global → library reverts to passthrough |

Flow (`src/main.ts`):
- **Publisher:** read `streams.encrypted`; if on, `armPublisher()` at load (before any
  frame). At go-live, `setMediaKey(res.contentKey)` *before* setting the connection
  URL. If the server says encrypted but returns no key, refuse to go live.
- **Viewer:** from `/route`, if `encrypted` and a `contentKey` is present,
  `armViewer()` + `setMediaKey()` *before* connecting. If encrypted but the key was
  withheld (auth-gated, not signed in), surface the sign-in requirement.

**UI:**
- A per-stream **"Encrypt media end-to-end"** toggle in the broadcast view
  (`streams.encrypted`).
- A green **🔒 Encrypted** badge: in the publisher's stream header (reflects the
  toggle live) and overlaid on the viewer's player. The viewer badge is a genuine
  signal — it is driven by the same `route.encrypted` + content-key path that arms
  decryption, so if it shows, the frames really were decrypted (the relay saw only
  ciphertext).

---

## 9. Limitations & v2

- **No live revocation.** The per-session key is static. A viewer removed
  mid-broadcast who kept the key can still decrypt the ongoing stream, and a saved
  ciphertext recording can be decrypted with the key. Live decryption-revocation
  requires key rotation + redistribution (SFrame/MLS territory) — out of scope for
  v1.
- **Not DRM.** Authorized viewers can capture decoded frames.
- **Catalog metadata is in the clear** (codec/resolution) — see [§6](#6-what-stays-in-the-clear-and-why).
- **Legacy container only.** The seams target the legacy container (the live default).
  If a stream ever used `loc`/`cmaf`, those payloads would not be encrypted; the
  build-time fail-closed check guards the legacy seams specifically.

Possible v2 work: epoch-based key rotation for revocation, encrypting the decoder
config via the key channel, and a per-frame format version byte for forward
compatibility.

---

## 10. Verification

- **Unit:** AES-GCM frame round-trip — identity, cleartext-varint preserved, 28-byte
  overhead, tamper detection, AAD-tamper detection, wrong-key fail-closed.
- **Build:** fail-closed `buildEnd` confirms all three seams patched.
- **Production:** `GET /api/streams/:id` exposes `encrypted`; a live encrypted stream
  returns `encrypted:true` + a content key on `/route`; the patched seams ship in the
  deployed chunks.
- **End-to-end (browser):** publish + watch with the toggle on renders video with no
  `[media-crypto] decrypt failed` console lines. Because the viewer arms decryption
  from `route.encrypted`, successful playback proves the encrypt→relay→decrypt path:
  had the publisher sent plaintext while the viewer decrypted, every GCM tag check
  would fail and nothing would render.

---

## 11. File map

| Concern | Path |
|---------|------|
| Crypto core (AES-GCM, nonce, ordering, key mgmt) | `src/crypto/media-crypto.ts` |
| Build-time library patch (3 seams, fail-closed) | `vite.config.ts` → `mediaCryptoPatch()` |
| Key generate / store / distribute / auth-gate | `src/worker/index.ts` (`/api/stats/broadcast`, `/api/streams/:id/route`, `generateContentKey`) |
| Schema | `src/worker/db/migrations/0005_add_media_encryption.sql`, `src/worker/db/schema.sql` |
| Client return shapes | `src/auth.ts` (`BroadcastStart`, `StreamRoute`, `StreamSettings`) |
| Client wiring + toggle + badge | `src/main.ts`, `index.html` |
| Access tokens (companion layer) | `PER-BROADCAST-TOKENS.md` |
