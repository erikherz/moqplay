# MoQ Handshake Patch for Cloudflare relay-next

## Overview

This document describes the compatibility patch required to make `@kixelated/moq` (used by `@kixelated/hang`) work with Cloudflare's `relay-next.cloudflare.mediaoverquic.com` endpoint, which implements IETF MoQ Transport draft-14.

## The Problem

### Symptom
When connecting to `relay-next.cloudflare.mediaoverquic.com`:
- WebTransport QUIC connection succeeds (READY in ~80-100ms)
- MoQ handshake fails immediately
- Error: `unexpected end of stream`
- Server closes connection without responding

### Root Cause
The `@kixelated/moq` library uses **SessionCompat mode** (`0x20`/`0x21`) for maximum compatibility with different server implementations. However, Cloudflare's relay-next expects **pure IETF draft-14 format** (`0x40`/`0x41`).

| Format | Client Sends | Server Responds | Used By |
|--------|-------------|-----------------|---------|
| SessionCompat (moq-lite) | `0x20` | `0x21` | Luke's relay.moq.dev |
| Pure IETF draft-14 | `0x40` | `0x41` | Cloudflare relay-next |

## Technical Details

### Wire Format Comparison

**SessionCompat (what moq-lite sends by default):**
```
[0x20]                    <- Stream type: ClientCompat
[u16 length]              <- Message length
[versions...]             <- Supported versions
[parameters...]           <- Setup parameters
```

**Pure IETF draft-14 (what Cloudflare expects):**
```
[0x40]                    <- Message type: CLIENT_SETUP
[u16 length]              <- Message length
[versions...]             <- Supported versions
[parameters...]           <- Setup parameters
```

### Code Location

The handshake logic is in:
```
node_modules/@kixelated/moq/connection/connect.js
```

### Original Code (SessionCompat)

```javascript
// Lines 42-55 in connect.js

// moq-rs currently requires the ROLE extension to be set.
const stream = await Stream.open(quic);
// We're encoding 0x20 so it's backwards compatible with moq-transport-10+
await stream.writer.u53(Lite.StreamId.ClientCompat);  // 0x20
const encoder = new TextEncoder();
const params = new Ietf.Parameters();
params.set(2n, new Uint8Array([63]));
params.set(5n, encoder.encode("moq-lite-js"));
const msg = new Ietf.ClientSetup([Lite.CURRENT_VERSION, Ietf.CURRENT_VERSION], params);
await msg.encode(stream.writer);
// And we expect 0x21 as the response.
const serverCompat = await stream.reader.u53();
if (serverCompat !== Lite.StreamId.ServerCompat) {  // 0x21
    throw new Error(`unsupported server message type: ${serverCompat.toString()}`);
}
```

### Patched Code (IETF draft-14)

```javascript
// Lines 42-55 in connect.js (patched)

// moq-rs currently requires the ROLE extension to be set.
const stream = await Stream.open(quic);
// PATCHED: Send 0x40 (IETF CLIENT_SETUP) instead of 0x20 (SessionCompat) for Cloudflare relay-next
await stream.writer.u53(0x40);
const encoder = new TextEncoder();
const params = new Ietf.Parameters();
params.set(2n, new Uint8Array([63]));
params.set(5n, encoder.encode("moq-lite-js"));
const msg = new Ietf.ClientSetup([Lite.CURRENT_VERSION, Ietf.CURRENT_VERSION], params);
await msg.encode(stream.writer);
// PATCHED: Expect 0x41 (IETF SERVER_SETUP) instead of 0x21 (ServerCompat) for Cloudflare relay-next
const serverSetupType = await stream.reader.u53();
if (serverSetupType !== 0x41) {
    throw new Error(`unsupported server message type: ${serverSetupType.toString()}, expected 0x41`);
}
```

### Summary of Changes

| Line | Original | Patched |
|------|----------|---------|
| 44 | `await stream.writer.u53(Lite.StreamId.ClientCompat);` | `await stream.writer.u53(0x40);` |
| 52 | `const serverCompat = await stream.reader.u53();` | `const serverSetupType = await stream.reader.u53();` |
| 53 | `if (serverCompat !== Lite.StreamId.ServerCompat)` | `if (serverSetupType !== 0x41)` |

## Applying the Patch

### Method 1: Using patch-package (Recommended)

1. Install patch-package:
   ```bash
   npm install patch-package --save-dev
   ```

2. Add postinstall script to `package.json`:
   ```json
   {
     "scripts": {
       "postinstall": "patch-package"
     }
   }
   ```

3. Create `patches/@kixelated+moq+0.9.4.patch`:
   ```diff
   diff --git a/node_modules/@kixelated/moq/connection/connect.js b/node_modules/@kixelated/moq/connection/connect.js
   index ce99c7b..378172c 100644
   --- a/node_modules/@kixelated/moq/connection/connect.js
   +++ b/node_modules/@kixelated/moq/connection/connect.js
   @@ -40,18 +40,18 @@ export async function connect(url, props) {
        }
        // moq-rs currently requires the ROLE extension to be set.
        const stream = await Stream.open(quic);
   -    // We're encoding 0x20 so it's backwards compatible with moq-transport-10+
   -    await stream.writer.u53(Lite.StreamId.ClientCompat);
   +    // PATCHED: Send 0x40 (IETF CLIENT_SETUP) instead of 0x20 (SessionCompat) for Cloudflare relay-next
   +    await stream.writer.u53(0x40);
        const encoder = new TextEncoder();
        const params = new Ietf.Parameters();
        params.set(2n, new Uint8Array([63])); // Allow some request_ids without delving into varint encoding.
        params.set(5n, encoder.encode("moq-lite-js")); // Put the implementation name in the parameters.
        const msg = new Ietf.ClientSetup([Lite.CURRENT_VERSION, Ietf.CURRENT_VERSION], params);
        await msg.encode(stream.writer);
   -    // And we expect 0x21 as the response.
   -    const serverCompat = await stream.reader.u53();
   -    if (serverCompat !== Lite.StreamId.ServerCompat) {
   -        throw new Error(`unsupported server message type: ${serverCompat.toString()}`);
   +    // PATCHED: Expect 0x41 (IETF SERVER_SETUP) instead of 0x21 (ServerCompat) for Cloudflare relay-next
   +    const serverSetupType = await stream.reader.u53();
   +    if (serverSetupType !== 0x41) {
   +        throw new Error(`unsupported server message type: ${serverSetupType.toString()}, expected 0x41`);
        }
        const server = await Ietf.ServerSetup.decode(stream.reader);
        if (server.version === Lite.CURRENT_VERSION) {
   ```

4. Run `npm install` to apply the patch automatically.

### Method 2: Manual Patching

1. Open `node_modules/@kixelated/moq/connection/connect.js`
2. Find line ~44: `await stream.writer.u53(Lite.StreamId.ClientCompat);`
3. Change to: `await stream.writer.u53(0x40);`
4. Find line ~52-54 (the serverCompat check)
5. Change to expect `0x41` instead of `Lite.StreamId.ServerCompat`

## Version Compatibility

| @kixelated/moq | @kixelated/hang | Patch Required |
|----------------|-----------------|----------------|
| 0.9.4 | 0.7.0 | Yes |

**Note:** When upgrading these packages, verify the patch still applies. The line numbers may shift but the logic should remain similar.

## Background Context

From Luke Curley (kixelated) on Discord (December 1, 2025):

> "the server will support the first byte being 0x00, 0x20, or 0x40, but the client only uses 0x20"

> "yeah, and this is the main reason why I dropped support for Cloudflare's relay because it needs the first byte to be 0x40 for draft-07"

> "so my advice is to implement the IETF draft 14 CLIENT_SETUP/SERVER_SETUP then you can switch back to moq-lite"

The moq-lite client uses `0x20` (SessionCompat) for maximum compatibility with various servers. However, Cloudflare's relay only accepts `0x40` (pure IETF format). This patch makes the client send `0x40` to work with Cloudflare.

## Protocol References

- **IETF MoQ Transport draft-14:** CLIENT_SETUP = `0x40`, SERVER_SETUP = `0x41`
- **moq-lite SessionCompat:** ClientCompat = `0x20`, ServerCompat = `0x21`
- **moq-lite Session:** Session = `0x00`

## Testing

After applying the patch:

1. WebTransport should connect successfully
2. Console should show: `moq-ietf session established`
3. No "unexpected end of stream" errors
4. Publisher status should change from "connecting" to "connected"

## Future Considerations

- Luke mentioned WebTransport ALPN will eventually replace the first-byte negotiation
- IETF draft-15+ requires ALPN
- SessionCompat (`0x20`) is being removed from the IETF spec
- This patch may become unnecessary if:
  - Cloudflare adds `0x20` support, OR
  - Luke adds a configuration option to send `0x40`, OR
  - ALPN negotiation becomes standard
