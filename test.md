# Earthseed MOQ Protocol Tests

Unit tests for the MOQ (Media over QUIC) Transport draft-14 protocol used by earthseed.live to connect to the Cloudflare relay at `relay-next.cloudflare.mediaoverquic.com`.

## Running Tests

```bash
npm test
```

Or directly:

```bash
npx vitest run
```

Watch mode (re-runs on file changes):

```bash
npx vitest
```

## Test File

`test/moq-protocol.test.ts`

## What's Tested

### Publisher Protocol (Cloudflare draft-14)

| Test | Description |
|------|-------------|
| CLIENT_SETUP encoding | Verifies the handshake message encodes version DRAFT_14 (`0xff00000e`) with Cloudflare's u16 length-prefix format |
| SERVER_SETUP decoding | Parses Cloudflare's int-param format where even key IDs are varint values (e.g. `MAX_REQUEST_ID=63` at param id 2) |
| Full publisher handshake | End-to-end flow: CLIENT_SETUP -> SERVER_SETUP -> PUBLISH_NAMESPACE with namespace `earthseed.live/{streamId}` -> PUBLISH_NAMESPACE_OK |
| Relay URL and namespace format | Validates the 5-char alphanumeric stream ID convention and namespace splitting into parts |

### Viewer Protocol (Cloudflare draft-14)

| Test | Description |
|------|-------------|
| CLIENT_SETUP encoding | Confirms viewers use the identical handshake as publishers |
| SUBSCRIBE for video track | Verifies SUBSCRIBE message: namespace, track name, priority, group order (descending), forward flag, LatestGroup filter (`0x01`) |
| SUBSCRIBE for audio track | Tests audio subscription with different priority and request ID (increments by 2) |
| Full viewer handshake | End-to-end flow: CLIENT_SETUP -> SERVER_SETUP -> SUBSCRIBE -> SUBSCRIBE_OK with track alias matching |
| Cloudflare relay detection | Tests the URL-based relay identification that selects the draft-14 handshake path vs Luke's moq-lite path |

## Protocol Overview

The tests verify the byte-level protocol exchange between earthseed and the Cloudflare MOQ relay:

```
Publisher                          Cloudflare Relay
   |                                     |
   |-- CLIENT_SETUP (DRAFT_14) --------->|
   |<-------- SERVER_SETUP (DRAFT_14) ---|
   |                                     |
   |-- PUBLISH_NAMESPACE (stream ns) --->|
   |<-------- PUBLISH_NAMESPACE_OK ------|
   |                                     |
   |== media data (object streams) =====>|

Viewer                             Cloudflare Relay
   |                                     |
   |-- CLIENT_SETUP (DRAFT_14) --------->|
   |<-------- SERVER_SETUP (DRAFT_14) ---|
   |                                     |
   |-- SUBSCRIBE (video/audio) --------->|
   |<-------- SUBSCRIBE_OK -------------|
   |                                     |
   |<== media data (object streams) =====|
```

Key Cloudflare-specific behaviors tested:
- **u16 length prefix** on setup messages (vs varint in other relays)
- **Int-param format**: even param IDs encode values as varints, odd as length-prefixed bytes
- **DRAFT_14 version** (`0xff00000e`) sent as the only supported version
- **No MaxRequestId control message** after handshake (sent as setup param instead)
- **Request IDs increment by 2** (client uses even IDs)

## Dependencies

- [vitest](https://vitest.dev/) - test runner (configured in `vitest.config.ts`)
