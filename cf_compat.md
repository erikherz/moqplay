# Cloudflare MoQ Relay Compatibility

This document describes the protocol differences between Luke's relay (`cdn.moq.dev/anon`) and Cloudflare's draft-14 relay (`relay-next.cloudflare.mediaoverquic.com`), and how we handle both.

## Background

The `@kixelated/moq` library supports both:
- **moq-lite** (LITE_01 = 0xff0d0101) - Luke's relay
- **moq-ietf** (DRAFT_14 = 0xff00000e) - Cloudflare's relay

The library negotiates the version during handshake, but Cloudflare's implementation has additional encoding differences that require special handling.

**Reference**: [cloudflare/moq-rs](https://github.com/cloudflare/moq-rs) - Rust implementation targeting draft-14

## Architecture

The patched `connect.js` auto-detects the relay type from the URL and uses the appropriate handshake:

```javascript
function isCloudflareRelay(url) {
    return url.toString().toLowerCase().includes("cloudflare");
}
```

- **Luke's relay**: `lukeHandshake()` - sends both versions, uses original library decode
- **Cloudflare**: `cloudflareHandshake()` - sends DRAFT_14 only, uses custom decode

## Protocol Differences

### 1. Setup Message Types

Both use the same message types (drafts 11+):

| Message | Type |
|---------|------|
| CLIENT_SETUP | `0x20` |
| SERVER_SETUP | `0x21` |

### 2. Message Length Encoding (Setup Messages)

| Relay | Length Encoding |
|-------|-----------------|
| Luke (moq-lite) | varint via `u53()` |
| Cloudflare (draft-14) | **u16** (16-bit big-endian) |

**Note**: The library's `ietf/message.js` already uses u16, but Luke's server returns LITE_01 version which uses `lite/message.js` with varint encoding.

### 3. Version Negotiation

| Relay | Versions Sent | Version Returned |
|-------|---------------|------------------|
| Luke | `[LITE_01, DRAFT_14]` | LITE_01 (0xff0d0101) |
| Cloudflare | `[DRAFT_14]` | DRAFT_14 (0xff00000e) |

### 4. Parameter Encoding (KeyValuePairs)

**Critical difference** - Cloudflare uses **key parity** to determine value type:

| Key Parity | Value Type | Encoding |
|------------|------------|----------|
| **Even** (0, 2, 4...) | IntValue | `key (varint) + value (varint)` |
| **Odd** (1, 3, 5...) | BytesValue | `key (varint) + length (varint) + bytes` |

Luke's relay (and the library) assumes ALL parameters are bytes with length prefix.

**Source**: `moq-rs/moq-transport/src/coding/kvp.rs`

**Example**: Cloudflare sends param id=2 (MAX_REQUEST_ID) with value=100
- Cloudflare sends: `[0x02] [0x64]` (key=2, intValue=100 as varint)
- Library expected: `[0x02] [length] [bytes...]`

### 5. Parameters Observed

**Cloudflare SERVER_SETUP**:
- `id=2` (MAX_REQUEST_ID): IntValue = 100

**Luke CLIENT_SETUP** (what we send):
- `id=2`: bytes `[63]` (MAX_REQUEST_ID as byte)
- `id=5`: bytes `"earthseed"` (implementation name)

## Files Modified

### `src/patched-moq/connect.js`
Main patched file with dual relay support:
- `isCloudflareRelay(url)` - detects relay type from URL
- `lukeHandshake()` - original library behavior for Luke's relay
- `cloudflareHandshake()` - custom handshake for Cloudflare
- `encodeClientSetupCF()` - u16 length encoding for CLIENT_SETUP
- `decodeServerSetupCF()` - u16 length + int-param handling for SERVER_SETUP

### `src/patched-moq/connection.js`
Patched Connection class for Cloudflare:
- Skips sending MaxRequestId (not supported by moq-rs)
- Uses patched control.js, subscriber.js, object.js
- Debug logging for object streams

### `src/patched-moq/control.js`
Patched control message handler:
- Imports Subscribe from patched subscribe.js (fixes instanceof checks)
- Debug logging for control messages

### `src/patched-moq/subscribe.js`
Patched Subscribe class:
- Accepts filter types 1 (LatestGroup) AND 2 (LatestObject)

### `src/patched-moq/subscriber.js`
Patched Subscriber class:
- Uses patched object.js for Frame decoding
- Debug logging for subscription flow

### `src/patched-moq/object.js`
Patched Group/Frame classes:
- Reads Subgroup ID when `hasSubgroupObject` is set (not just `hasSubgroup`)
- Skips extensions instead of throwing
- Debug logging for object stream decoding

### `vite.config.ts`
Custom Vite plugin to intercept module imports:
- Redirects `./connect.js` and `./connection/index.js` to patched versions
- Resolves relative imports from patched files back to moq package

### `src/main.ts`
Configuration toggle:
```typescript
const RELAY_SERVER: "luke" | "cloudflare" = "cloudflare";
```

### 6. MaxRequestId Control Message

| Relay | Behavior |
|-------|----------|
| Luke | Expects `MAX_REQUEST_ID` (0x15) as control message after handshake |
| Cloudflare | Does **NOT** support MAX_REQUEST_ID as control message (uses setup param id=2 instead) |

**Fix**: Patched `connection.js` skips sending MaxRequestId for Cloudflare.

### 7. Subscribe Filter Types

| Filter Type | Name | Support |
|-------------|------|---------|
| 0x01 | LatestGroup | Both relays |
| 0x02 | LatestObject | **Cloudflare only** |

**Fix**: Patched `subscribe.js` accepts both filter types 1 and 2.

### 8. Object Stream Format (Subgroup ID)

For `OBJECT_WITH_SUBGROUP_OBJECT` streams (id 0x14-0x17, 0x1c-0x1f), the GROUP header **always** includes a Subgroup ID field, even when the `hasSubgroup` bit (0x02) is not set.

| Stream Type | hasSubgroupObject (0x04) | Subgroup ID in Header |
|-------------|--------------------------|----------------------|
| 0x10-0x13 | false | Only if hasSubgroup |
| 0x14-0x17 | **true** | **Always present** |

**Fix**: Patched `object.js` reads Subgroup ID when `hasSubgroup OR hasSubgroupObject` is set.

## Current Status

**Working**:
- ✅ Luke's relay (moq-lite) - full functionality
- ✅ Cloudflare handshake (CLIENT_SETUP/SERVER_SETUP)
- ✅ Version negotiation
- ✅ Parameter decoding with int/bytes handling
- ✅ PUBLISH_NAMESPACE / SUBSCRIBE flow
- ✅ Object stream decoding (video/audio data)
- ✅ End-to-end video streaming

### URL vs Namespace Fix

**Root cause of STOP_SENDING**: The namespace was being sent in BOTH the WebTransport URL AND the PUBLISH_NAMESPACE message.

**Reference from moq-pub**: In `moq-rs/moq-pub/src/main.rs`, URL and namespace are separate:
```rust
pub url: Url,    // Just the relay server
pub name: String, // Broadcast namespace for PUBLISH_NAMESPACE
```

**Fix applied**: `getRelayConfig()` now returns just the relay URL for both relays:
```javascript
return {
  url: RELAY_URL,      // "https://relay-next.cloudflare.mediaoverquic.com"
  name: streamName,    // "earthseed.live/streamId" → goes in PUBLISH_NAMESPACE
};
```

## Summary of Cloudflare Fixes

1. **Handshake**: u16 length encoding, int-param decoding
2. **MaxRequestId**: Skip sending (uses setup param instead)
3. **Filter Types**: Accept both 1 and 2
4. **Object Streams**: Read Subgroup ID for hasSubgroupObject streams

## Testing

Set `RELAY_SERVER` in `src/main.ts` and deploy:

**Luke's relay**:
```
[MOQ] connect() URL: https://cdn.moq.dev/anon/... isCloudflare: false
[MOQ] Luke relay handshake - sending CLIENT_SETUP with both versions
[MOQ] Luke relay - server version: 0xff0d0101
[MOQ] Luke relay - moq-lite session established
```

**Cloudflare relay**:
```
[MOQ] connect() URL: https://relay-next.cloudflare... isCloudflare: true
[MOQ] Cloudflare relay handshake - sending CLIENT_SETUP with DRAFT_14 only
[MOQ CF] ServerSetup version: 0xff00000e
[MOQ CF] param id=2n intValue=100
[MOQ] Cloudflare relay - moq-ietf/draft-14 session established
```
