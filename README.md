# MoQplay

Open-source MoQ (Media over QUIC) player for low-latency live streaming.

## Features

- **Sub-Second TTFF** — ~350-550ms time-to-first-frame on nearby relays. Direct MSE rendering with no player library overhead.
- **Adaptive Bitrate** — Buffer-based ABR with automatic track switching. Supports multi-rendition CMAF streams.
- **Player Stats** — Press 'I' for real-time overlay: TTFF, buffer health, ABR state, framerate, dropped frames, and stale fragment tracking.

## Quick Start

Open `index.html` in a browser, enter a relay URL and namespace, and click Play.

## Files

| File | Description |
|------|-------------|
| `moqt-player.js` | MoQ Transport player — WebTransport connection, MoQ protocol, ABR, track management |
| `fragment-appender.js` | MSE SourceBuffer management — codec detection, fragment batching, buffer append queue |
| `qmux.js` | WebSocket fallback — WebTransport polyfill for browsers without QUIC support |
| `stats.js` | Optional stats overlay — press 'I' to toggle, auto-attaches to any MoqtPlayer instance |
| `index.html` | Demo player page |

## Usage

```html
<video id="video" autoplay muted playsinline></video>
<script src="https://moqplay.com/js/qmux.js"></script>
<script src="https://moqplay.com/js/fragment-appender.js"></script>
<script src="https://moqplay.com/js/moqt-player.js"></script>
<script src="https://moqplay.com/js/stats.js"></script>
<script>
  const video = document.getElementById('video');
  const player = new MoqtPlayer(video, 'https://your-relay.example.com', 'your-stream');
  player.connect();
  video.play().catch(() => {});
</script>
```

## API

### `new MoqtPlayer(video, relayUrl, namespace, opts?)`

| Argument | Type | Description |
|----------|------|-------------|
| `video` | HTMLVideoElement | Video element for playback |
| `relayUrl` | string | MoQ relay URL (https://) |
| `namespace` | string | Stream namespace to subscribe to |
| `opts` | object | Optional: `{ onStatus: (msg) => {} }` |

### `player.connect()`

Connects to the relay via WebTransport (with WebSocket fallback), performs MoQ SETUP exchange, subscribes to catalog, and begins playback.

### `player.getStats()`

Returns current player statistics including buffer health, ABR state, framerate, and more.

### `player.getTiming()`

Returns TTFF pipeline timing: SETUP, catalog, first fragment, first decoded frame.

### `player.destroy()`

Closes the connection and cleans up resources.

## Publishing

Use [moqpush](https://github.com/erikherz/moqpush-open) to publish CMAF streams to a MoQ relay.

## License

MIT
