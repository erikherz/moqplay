# Earthseed

MoQ (Media over QUIC) streaming application using Cloudflare's relay network.

## Architecture

- **Frontend**: Vite + [@kixelated/hang](https://www.npmjs.com/package/@kixelated/hang) v0.3.12 web components
- **Relay**: Cloudflare's public MoQ relay (`relay.cloudflare.mediaoverquic.com`)
- **Protocol**: IETF MoQ Transport draft-07
- **Hosting**: Cloudflare Workers (static assets only)

```
┌─────────────┐         ┌──────────────────────────────┐         ┌─────────────┐
│   Browser   │ ──────▶ │  relay.cloudflare.           │ ◀────── │   Browser   │
│ (Publisher) │  QUIC   │  mediaoverquic.com           │  QUIC   │ (Watcher)   │
│             │         │  (Cloudflare MoQ Relay)      │         │             │
│ hang-publish│         └──────────────────────────────┘         │ hang-watch  │
└─────────────┘                                                  └─────────────┘
       │                                                                │
       └──── Static HTML/JS served from earthseed.live (CF Workers) ───────┘
```

## Requirements

- **Browser**: Chrome 97+, Edge 97+, Firefox 114+, or Safari 17+ (see Safari Support below)
- **Node.js**: 20+

## Safari Support

Safari lacks full WebTransport support, so earthseed.live includes a WebSocket polyfill that transparently falls back to WebSocket-enabled relay servers.

### Architecture

```
┌─────────────┐         ┌──────────────────────────────┐         ┌──────────────────────────────┐
│   Safari    │ ──────▶ │  Linode Relay Server         │ ──────▶ │  relay.cloudflare.           │
│   Browser   │WebSocket│  (moq-relay + WebSocket)     │  QUIC   │  mediaoverquic.com           │
│             │         │                              │         │  (Cloudflare MoQ Relay)      │
└─────────────┘         └──────────────────────────────┘         └──────────────────────────────┘
```

### How It Works

1. **Detection**: The frontend detects Safari and loads the WebSocket polyfill (`webtransport-polyfill.ts`)
2. **Relay Selection**: A latency race selects the fastest Linode relay server:
   - `us-central.earthseed.live` (Dallas)
   - `eu-central.earthseed.live` (Frankfurt)
   - `ap-south.earthseed.live` (Singapore)
3. **WebSocket Connection**: Safari connects to the Linode relay via WebSocket
4. **Stream Proxy**: The relay uses the announce hostname to fetch streams from Cloudflare's relay over QUIC

### Linode Relay Servers

Each Linode server runs a patched version of [moq-relay](https://github.com/kixelated/moq-rs) with:
- WebSocket support from the `@kixelated/hang` library
- A patch that announces to and fetches from Cloudflare's relay (`relay.cloudflare.mediaoverquic.com`)
- This allows Safari users to watch streams published by Chrome/Firefox users via the native Cloudflare relay

## Development

```bash
npm install
npm run dev      # Start Vite dev server on localhost:3000
```

## Deploy

```bash
npm run deploy   # Build and deploy to Cloudflare
```

## Usage

### Stream-Based Sessions

Each session uses a unique 5-character stream ID for isolation:

- **Visit `earthseed.live`** → Auto-generates a stream (e.g., `https://earthseed.live/ab3x9`)
- **Share the URL** → Others open the same URL to watch
- **Click "+ New Stream"** → Creates a fresh stream

### Broadcasting

1. Open https://earthseed.live in Chrome
2. A unique 5-character stream ID is generated automatically
3. Click "Start" in the Broadcast section
4. Allow camera and microphone access
5. Share the URL with viewers (e.g., `https://earthseed.live/ab3x9`)

### Watching

1. Open the shared URL (e.g., `https://earthseed.live/ab3x9`)
2. The stream begins playing automatically
3. Click play if needed

### Stream Namespace

Streams use the format: `earthseed.live/{streamId}`

Each 5-character stream ID maps to a unique namespace on the Cloudflare relay, preventing conflicts between sessions.

## Interoperability

**Key point:** This project uses `@kixelated/hang@0.3.12` specifically for compatibility with Cloudflare's draft-07 relay. Newer versions (0.4+) use draft-14 and won't connect.

## Links

- [Live Site](https://earthseed.live)
- [Cloudflare MoQ Docs](https://developers.cloudflare.com/moq/)
- [MoQ Protocol](https://moq.dev/)
