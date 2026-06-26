# QUIC Zapping: Instant Stream Switching for Earthseed Scroll View

## Overview

This document describes the "QUIC Zapping" technique for achieving near-instant stream switching in the Earthseed `/scroll` view. By leveraging MoQ's (Media over QUIC) selective track subscription, we can pre-establish connections and buffer audio for upcoming streams while minimizing bandwidth usage.

## The Problem

When a user swipes to the next stream in a TikTok-style interface, they expect instant playback. However:

1. **QUIC handshake**: ~50-100ms
2. **MoQ subscription setup**: ~20-50ms
3. **First keyframe wait**: ~100-2000ms (depends on GOP size)
4. **Buffer fill**: ~100-500ms

**Total cold-start latency: 300ms - 3 seconds**

This is unacceptable for a fluid scrolling experience.

## The Solution: 5-Slot Preloading Deck

We maintain 5 concurrent connections in a "deck" formation:

```
Position:   -2        -1        0         +1        +2
           ┌───┐    ┌───┐    ┌───┐     ┌───┐    ┌───┐
           │ A │    │V+A│    │V+A│     │V+A│    │ A │
           │   │    │   │    │ ◉ │     │   │    │   │
           └───┘    └───┘    └───┘     └───┘    └───┘
          OUTER    INNER    CURRENT   INNER    OUTER

Legend:
  A   = Audio only (video disabled)
  V+A = Video + Audio (full stream)
  ◉   = Visible to user
```

### Ring Architecture

| Ring | Positions | Video | Audio | Visibility | Purpose |
|------|-----------|-------|-------|------------|---------|
| **Outer** | -2, +2 | Disabled | Enabled | Hidden | Connection warm, minimal bandwidth |
| **Inner** | -1, +1 | Enabled | Enabled | Hidden | Instant switch ready |
| **Center** | 0 | Enabled | Enabled | **Visible** | Currently playing |

### Bandwidth Analysis

| Component | Bitrate | Count | Subtotal |
|-----------|---------|-------|----------|
| Current stream (V+A) | ~3 Mbps | 1 | 3 Mbps |
| Inner ring (V+A) | ~3 Mbps | 2 | 6 Mbps |
| Outer ring (A only) | ~50 kbps | 2 | 100 kbps |
| **Total** | | **5 streams** | **~9.1 Mbps** |

Compared to naive 5-stream preloading at ~15 Mbps, this saves **~40% bandwidth**.

---

## How It Works: MoQ Track Subscription

### The hang-watch Component

The `hang-watch` web component from `@moq/hang` manages MoQ connections and exposes reactive signals for track control:

```javascript
// hang-watch element structure
hangWatch.broadcast = {
  video: {
    enabled: Signal<boolean>,  // Controls video subscription
    target: Signal<Target>,    // Resolution/rendition selection
    active: Signal<string>,    // Currently active rendition
  },
  audio: {
    enabled: Signal<boolean>,  // Controls audio subscription
    active: Signal<string>,    // Currently active rendition
  }
}
```

### Enabling/Disabling Video

When `video.enabled` is set to `false`:
1. The video track subscription is **not sent** to the relay
2. No video data is received (saves bandwidth)
3. Audio continues playing normally
4. The QUIC connection remains established

```javascript
// Disable video (audio-only mode)
watchElement.broadcast.video.enabled.set(false);

// Enable video (full stream)
watchElement.broadcast.video.enabled.set(true);
```

### Subscription Flow

```
┌─────────────────────────────────────────────────────────────┐
│                     MoQ Relay Server                         │
└─────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
   ┌──────────┐         ┌──────────┐         ┌──────────┐
   │ QUIC     │         │ QUIC     │         │ QUIC     │
   │ Conn -2  │         │ Conn 0   │         │ Conn +2  │
   └──────────┘         └──────────┘         └──────────┘
         │                    │                    │
    ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
    │         │          │         │          │         │
    ▼         ▼          ▼         ▼          ▼         ▼
 ┌─────┐  ┌─────┐     ┌─────┐  ┌─────┐     ┌─────┐  ┌─────┐
 │Catalog│ │Audio│    │Catalog│ │Audio│    │Catalog│ │Audio│
 │  ✓   │ │  ✓  │     │  ✓   │ │  ✓  │     │  ✓   │ │  ✓  │
 └─────┘  └─────┘     └─────┘  └─────┘     └─────┘  └─────┘
                           │
                           ▼
                       ┌─────┐
                       │Video│  ← Only subscribed for inner ring + current
                       │  ✓  │
                       └─────┘
```

---

## Deck State Machine

### State Definition

```typescript
interface DeckSlot {
  element: HTMLElement | null;      // The hang-watch element
  stream: ScrollBroadcast | null;   // Stream metadata
  position: DeckPosition;           // Current position in deck
  videoEnabled: boolean;            // Track subscription state
}

type DeckPosition = "far_prev" | "prev" | "current" | "next" | "far_next";

interface Deck {
  slots: Map<DeckPosition, DeckSlot>;
  historyStreams: ScrollBroadcast[];
  upcomingStreams: ScrollBroadcast[];
}
```

### Swipe Up Transition (Next Stream)

```
BEFORE SWIPE:
┌─────────┬─────────┬─────────┬─────────┬─────────┐
│ far_prev│  prev   │ current │  next   │far_next │
│ Stream A│ Stream B│ Stream C│ Stream D│ Stream E│
│ audio   │ video   │ VIDEO   │ video   │ audio   │
└─────────┴─────────┴─────────┴─────────┴─────────┘

USER SWIPES UP (go to next)
         ◄──────── everything shifts left ────────

AFTER SWIPE:
┌─────────┬─────────┬─────────┬─────────┬─────────┐
│ far_prev│  prev   │ current │  next   │far_next │
│ Stream B│ Stream C│ Stream D│ Stream E│ Stream F│
│ audio   │ video   │ VIDEO   │ video   │ audio   │
└─────────┴─────────┴─────────┴─────────┴─────────┘
     ↑         ↑         ↑         ↑         ↑
   demote    (same)   (same)   promote    CREATE
   B: V→A            show D    E: A→V    new F
```

**Actions on swipe up:**
1. **Remove** `far_prev` (Stream A) - close connection
2. **Demote** `prev` → `far_prev` (Stream B) - disable video
3. **Hide** `current` → `prev` (Stream C) - keep video running
4. **Show** `next` → `current` (Stream D) - already has video, just show
5. **Promote** `far_next` → `next` (Stream E) - enable video
6. **Create** new `far_next` (Stream F) - audio only

### Swipe Down Transition (Previous Stream)

```
BEFORE SWIPE:
┌─────────┬─────────┬─────────┬─────────┬─────────┐
│ far_prev│  prev   │ current │  next   │far_next │
│ Stream A│ Stream B│ Stream C│ Stream D│ Stream E│
│ audio   │ video   │ VIDEO   │ video   │ audio   │
└─────────┴─────────┴─────────┴─────────┴─────────┘

USER SWIPES DOWN (go to previous)
         ──────── everything shifts right ────────►

AFTER SWIPE:
┌─────────┬─────────┬─────────┬─────────┬─────────┐
│ far_prev│  prev   │ current │  next   │far_next │
│ Stream Z│ Stream A│ Stream B│ Stream C│ Stream D│
│ audio   │ video   │ VIDEO   │ video   │ audio   │
└─────────┴─────────┴─────────┴─────────┴─────────┘
     ↑         ↑         ↑         ↑         ↑
   CREATE   promote   (same)    (same)    demote
   new Z    A: A→V   show B             D: V→A
```

---

## Implementation

### Step 1: Deck Data Structure

```typescript
// Deck slot definition
interface DeckSlot {
  element: HTMLElement | null;
  stream: ScrollBroadcast | null;
  videoEnabled: boolean;
}

// Initialize the 5-slot deck
const deck: Record<DeckPosition, DeckSlot> = {
  far_prev: { element: null, stream: null, videoEnabled: false },
  prev:     { element: null, stream: null, videoEnabled: true },
  current:  { element: null, stream: null, videoEnabled: true },
  next:     { element: null, stream: null, videoEnabled: true },
  far_next: { element: null, stream: null, videoEnabled: false },
};

// Position metadata
const POSITION_CONFIG: Record<DeckPosition, { videoEnabled: boolean; visible: boolean }> = {
  far_prev: { videoEnabled: false, visible: false },
  prev:     { videoEnabled: true,  visible: false },
  current:  { videoEnabled: true,  visible: true  },
  next:     { videoEnabled: true,  visible: false },
  far_next: { videoEnabled: false, visible: false },
};
```

### Step 2: Create Watcher with Video Control

```typescript
// Wait for broadcast object to be available
function waitForBroadcast(element: HTMLElement): Promise<any> {
  return new Promise((resolve) => {
    const check = () => {
      const broadcast = (element as any).broadcast;
      if (broadcast?.video?.enabled) {
        resolve(broadcast);
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

// Create a hang-watch element with appropriate video state
async function createWatcher(
  stream: ScrollBroadcast,
  position: DeckPosition
): Promise<HTMLElement> {
  const relayConfig = getRelayConfig(stream.stream_id);
  const config = POSITION_CONFIG[position];

  // Create element
  const watcher = document.createElement("hang-watch");
  watcher.className = `scroll-deck-${position}`;
  watcher.setAttribute("muted", "");
  watcher.setAttribute("url", relayConfig.url);
  watcher.setAttribute("name", relayConfig.name);

  // Add canvas
  const canvas = document.createElement("canvas");
  watcher.appendChild(canvas);

  // Configure video subscription
  if (!config.videoEnabled) {
    const broadcast = await waitForBroadcast(watcher);
    broadcast.video.enabled.set(false);
    console.log(`[Scroll] ${position}: video DISABLED (audio-only)`);
  }

  return watcher;
}
```

### Step 3: Promote/Demote Functions

```typescript
// Promote: Enable video (outer → inner ring)
async function promoteSlot(slot: DeckSlot): Promise<void> {
  if (!slot.element || slot.videoEnabled) return;

  const broadcast = await waitForBroadcast(slot.element);
  broadcast.video.enabled.set(true);
  slot.videoEnabled = true;

  console.log(`[Scroll] Promoted ${slot.stream?.stream_id}: video ENABLED`);
}

// Demote: Disable video (inner → outer ring)
async function demoteSlot(slot: DeckSlot): Promise<void> {
  if (!slot.element || !slot.videoEnabled) return;

  const broadcast = await waitForBroadcast(slot.element);
  broadcast.video.enabled.set(false);
  slot.videoEnabled = false;

  console.log(`[Scroll] Demoted ${slot.stream?.stream_id}: video DISABLED`);
}
```

### Step 4: Navigation with Deck Rotation

```typescript
async function goToNextStream(): Promise<boolean> {
  // Check if we have a next stream
  if (!deck.next.stream) {
    console.log("[Scroll] No next stream available");
    return false;
  }

  // 1. Remove far_prev
  if (deck.far_prev.element) {
    deck.far_prev.element.remove();
  }

  // 2. Demote prev → far_prev
  deck.far_prev = { ...deck.prev };
  if (deck.far_prev.element) {
    deck.far_prev.element.className = "scroll-deck-far_prev";
    await demoteSlot(deck.far_prev);
  }

  // 3. Shift current → prev (keep video)
  deck.prev = { ...deck.current };
  if (deck.prev.element) {
    deck.prev.element.className = "scroll-deck-prev";
  }

  // 4. Shift next → current (already has video, just show)
  deck.current = { ...deck.next };
  if (deck.current.element) {
    deck.current.element.className = "scroll-deck-current";
  }

  // 5. Promote far_next → next
  deck.next = { ...deck.far_next };
  if (deck.next.element) {
    deck.next.element.className = "scroll-deck-next";
    await promoteSlot(deck.next);
  }

  // 6. Create new far_next (audio only)
  const nextStream = getNextUpcomingStream();
  if (nextStream) {
    deck.far_next = {
      element: await createWatcher(nextStream, "far_next"),
      stream: nextStream,
      videoEnabled: false,
    };
    videoWrapper.appendChild(deck.far_next.element);
  } else {
    deck.far_next = { element: null, stream: null, videoEnabled: false };
  }

  // Update UI
  updateStreamInfo(deck.current.stream);
  updatePositionIndicator();

  return true;
}
```

### Step 5: CSS for Deck Positions

```css
/* Current: visible, full size */
.scroll-deck-current {
  width: 100%;
  height: 100%;
  opacity: 1;
  z-index: 10;
}

/* Inner ring: hidden but video still decoding */
.scroll-deck-prev,
.scroll-deck-next {
  position: absolute;
  width: 100%;
  height: 100%;
  opacity: 0;
  pointer-events: none;
  z-index: 5;
}

/* Outer ring: hidden, audio only */
.scroll-deck-far_prev,
.scroll-deck-far_next {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 1;
}
```

---

## Timing Considerations

### When Video is Enabled (Promotion)

When promoting from outer ring to inner ring, video subscription starts:

1. **SUBSCRIBE message sent**: ~10ms
2. **Server starts sending video**: ~10-50ms
3. **Wait for keyframe**: 0-2000ms (depends on GOP)
4. **Decoder initialization**: ~20-50ms
5. **First frame rendered**: ~10ms

**Total promotion latency: 50ms - 2.1 seconds**

This happens in the background while the user is still watching the current stream.

### Optimal Timing Strategy

```
User watches stream 0 for average 5-10 seconds

Timeline:
  0.0s  - Stream 0 becomes current
  0.1s  - Stream +2 created (audio only) ← QUIC handshake starts
  0.3s  - Stream +2 connected (audio playing)
  0.5s  - Stream +1 promoted (video enabled) ← In parallel
  1.5s  - Stream +1 video ready (keyframe received)
  ...
  5.0s  - User swipes to stream +1
  5.0s  - INSTANT playback (video already buffered)
```

---

## Edge Cases

### 1. Rapid Swiping

If user swipes faster than promotion can complete:

```typescript
async function goToNextStream(): Promise<boolean> {
  // Check if next has video ready
  if (!deck.next.videoEnabled) {
    // Video not ready - show loading indicator briefly
    showLoadingIndicator();
    await promoteSlot(deck.next);
    hideLoadingIndicator();
  }
  // Continue with swap...
}
```

### 2. Stream Ends While Preloaded

```typescript
// Monitor preloaded streams for disconnection
function monitorSlot(slot: DeckSlot): void {
  if (!slot.element) return;

  const broadcast = (slot.element as any).broadcast;
  if (broadcast?.connection?.status) {
    broadcast.connection.status.subscribe((status: string) => {
      if (status === "closed" || status === "failed") {
        handleStreamEnded(slot);
      }
    });
  }
}
```

### 3. Not Enough Streams

```typescript
function initializeDeck(streams: ScrollBroadcast[]): void {
  // Handle cases with fewer than 5 streams
  if (streams.length === 0) {
    showNoStreamsMessage();
    return;
  }

  // Fill what we can
  if (streams.length >= 1) deck.current = createSlot(streams[0], "current");
  if (streams.length >= 2) deck.next = createSlot(streams[1], "next");
  if (streams.length >= 3) deck.far_next = createSlot(streams[2], "far_next");
  // prev and far_prev will be populated as user builds history
}
```

---

## Performance Monitoring

### Metrics to Track

```typescript
interface ZappingMetrics {
  // Timing
  promotionLatency: number[];      // Time to enable video
  switchLatency: number[];         // Time from swipe to first frame

  // Bandwidth
  totalBandwidth: number;          // Current aggregate bandwidth
  videoBandwidth: number;          // Video-only bandwidth
  audioBandwidth: number;          // Audio-only bandwidth

  // Quality
  bufferHealth: number;            // Seconds of buffer available
  keyframeWaitTime: number[];      // Time waiting for keyframes
}
```

### Logging

```typescript
function logZappingEvent(event: string, data: any): void {
  console.log(`[QUIC Zapping] ${event}`, {
    timestamp: Date.now(),
    deck: {
      far_prev: deck.far_prev.stream?.stream_id,
      prev: deck.prev.stream?.stream_id,
      current: deck.current.stream?.stream_id,
      next: deck.next.stream?.stream_id,
      far_next: deck.far_next.stream?.stream_id,
    },
    ...data,
  });
}
```

---

## Future Optimizations

### 1. Adaptive Ring Sizing

Adjust the number of preloaded streams based on:
- Available bandwidth
- Device memory
- Historical swipe patterns

### 2. Predictive Preloading

If user consistently swipes in one direction, preload more streams in that direction:

```typescript
const swipeHistory: ("up" | "down")[] = [];

function predictNextDirection(): "up" | "down" {
  const recentSwipes = swipeHistory.slice(-5);
  const upCount = recentSwipes.filter(s => s === "up").length;
  return upCount > 2.5 ? "up" : "down";
}
```

### 3. Quality Ladder

Use lower quality video for inner ring, upgrade to full quality for current:

```typescript
// Inner ring: 360p
deck.next.broadcast.video.target.set({ pixels: 640 * 360 });

// Current: full quality
deck.current.broadcast.video.target.set({ pixels: 1920 * 1080 });
```

---

## Page Load Sequence

The `/scroll` view has a complex initialization sequence with multiple async operations:

### 1. Script Execution (Immediate)

```
Lines 1-46: Runs immediately when script loads
├── Detect Safari via userAgent regex
├── If Safari/no WebTransport: installWebTransportPolyfill() [SYNC]
└── If Safari: Patch MediaStreamTrack.getSettings [SYNC]
```

### 2. DOMContentLoaded → `init()`

```
Waits for: document.readyState !== "loading"
Then calls init() async function
```

### 3. `init()` Function

```
├── detectBrowserSupport() [AWAIT - checks codecs]
│
├── selectBestLinodeRelay() [AWAIT]
│   └── Races 3 servers with 5 second timeout each
│   └── ⚠️ POTENTIAL DELAY: Up to 5s if servers slow/unreachable
│
├── loadHangComponents() [AWAIT]
│   ├── installWebCodecsPolyfill() [AWAIT - Safari audio codec]
│   ├── import("@moq/hang/publish/element") [AWAIT]
│   ├── import("@moq/hang/watch/element") [AWAIT]
│   ├── import("@moq/hang-ui/publish/element") [AWAIT]
│   └── import("@moq/hang-ui/watch/element") [AWAIT]
│   └── ⚠️ POTENTIAL DELAY: Network fetch of JS modules
│
├── getRouteInfo() [AWAIT - parses URL]
├── getCurrentUser() [AWAIT - fetch /api/auth/me]
│
└── initScrollView() [AWAIT for /scroll route]
```

### 4. `initScrollView()`

```
├── customElements.whenDefined("hang-watch") [AWAIT]
│   └── Waits for custom element registration
│
├── DOM element validation [SYNC]
│   └── Returns early if scroll-view or video-wrapper missing
│
├── fetchLiveBroadcasts() [AWAIT - fetch /api/stats/greet]
│
├── loadCurrentStream(stream) [AWAIT]
│   ├── createWatcher() [AWAIT]
│   └── updateDeck() [AWAIT - preloads adjacent streams]
│
├── Setup event listeners [SYNC]
│
└── setInterval(refreshInterval, 15000)
```

---

## Video Loading During Scrolling

### Swipe Up Flow (`goToNextStream`)

```
STEP 1: Check if next stream exists
────────────────────────────────────
├── If deck.next.stream is null AND upcomingStreams.length <= 1:
│   ├── fetchLiveBroadcasts() [AWAIT - network fetch]
│   │   └── GET /api/stats/greet
│   │   └── ⚠️ DELAY: Network latency (typically 50-200ms)
│   ├── Filter out existing streams
│   ├── updateDeck() [AWAIT]
│   └── If still no next stream → return false

STEP 2: Update watch tracking (fire-and-forget)
───────────────────────────────────────────────
├── logWatchEnd(watchEventId) [NO AWAIT]
└── logWatchStart(nextStreamId).then() [NO AWAIT]

STEP 3: Rotate deck LEFT (INSTANT - no awaits)
──────────────────────────────────────────────
├── far_prev.element.remove()
├── prev → far_prev + demoteSlot() [NO AWAIT]
├── current → prev (keeps video)
├── next → current ⚡ INSTANT SWITCH
├── far_next → next + promoteSlot() [NO AWAIT]
└── far_next = null

STEP 4: Update state & UI (INSTANT)
───────────────────────────────────
├── upcomingStreams.shift()
├── currentStream = deck.current.stream
├── Update UI text elements

STEP 5: Populate new far_next
─────────────────────────────
└── updateDeck() [AWAIT]
    └── updateSlot("far_next", stream) [AWAIT]
        └── createWatcher() [AWAIT]
```

### Timing Breakdown

| Phase | Blocking? | Typical Time | Notes |
|-------|-----------|--------------|-------|
| **Swipe to visible** | NO | **<16ms** | CSS class change + reference swap |
| Video switch | NO | **0ms** | next slot already has video enabled |
| demoteSlot() | NO | 0-5000ms | Background, polls every 50ms |
| promoteSlot() | NO | 0-5000ms | Background, polls every 50ms |
| updateDeck() | **YES** | 50-500ms | Creates new hang-watch element |
| fetchLiveBroadcasts() | **YES** | 50-200ms | Only if running low on streams |

### Key Timeouts

| Location | Timeout | Purpose |
|----------|---------|---------|
| waitForBroadcast() | 50ms × 100 = 5s max | Poll for broadcast object |
| wheelTimeout | 500ms | Debounce mouse wheel |
| CSS animation | 300ms | Swipe exit/enter animation |
| refreshInterval | 15000ms | Periodic stream list refresh |

---

## Stability Fixes (January 2026)

### iPhone Crash on Initial Load

**Problem**: `/scroll` would flash and crash on first load on iPhone, but work on reload.

**Root Causes**:
1. No wait for custom element registration
2. Missing null checks on DOM elements
3. Missing `await` on `loadCurrentStream()`
4. No error boundaries around element creation

**Fixes Applied**:

```typescript
// 1. Wait for custom element to be defined
await customElements.whenDefined("hang-watch");

// 2. Validate DOM elements exist
const scrollView = document.getElementById("scroll-view");
if (!scrollView) {
  console.error("[Scroll] scroll-view element not found");
  return;
}

// 3. Await loadCurrentStream
await loadCurrentStream(upcomingStreams[0]);

// 4. Try-catch in createWatcher
async function createWatcher(...): Promise<HTMLElement | null> {
  try {
    // ... element creation
    return watcher;
  } catch (err) {
    console.error(`[Scroll] Failed to create watcher:`, err);
    return null;
  }
}

// 5. Handle null watcher in loadCurrentStream
const watcher = await createWatcher(stream, "current");
if (!watcher) {
  showNoStreams();
  return;
}
```

---

## Broadcaster Heartbeat System

To prevent stale streams from appearing in `/scroll` and `/greet`, broadcasters send heartbeats:

### Database Schema

```sql
ALTER TABLE broadcast_events ADD COLUMN last_heartbeat TEXT;
CREATE INDEX idx_broadcast_events_last_heartbeat ON broadcast_events(last_heartbeat);
```

### API Endpoint

```
POST /api/stats/broadcast/:id/heartbeat
```

Updates `last_heartbeat = datetime('now')` for the broadcast.

### Client Implementation

```typescript
// Start heartbeat when broadcast starts
let heartbeatInterval: number | null = null;

logBroadcastStart(streamId, origin).then(id => {
  broadcastEventId = id;
  if (id) {
    heartbeatInterval = window.setInterval(() => {
      sendBroadcastHeartbeat(broadcastEventId);
    }, 5000);  // Every 5 seconds
  }
});

// Clear on broadcast end or page unload
if (heartbeatInterval) {
  clearInterval(heartbeatInterval);
}
```

### Stream List Filtering

The `/api/stats/greet` endpoint now filters by recent heartbeat:

```sql
WHERE b.ended_at IS NULL
  AND b.last_heartbeat IS NOT NULL
  AND b.last_heartbeat > datetime('now', '-15 seconds')
```

Stale streams automatically disappear after ~15 seconds of no heartbeat.

---

## Viewer Tracking

The `/scroll` view tracks watch events for analytics:

### On Stream Load

```typescript
logWatchStart(stream.stream_id).then(id => {
  watchEventId = id;
});
```

### On Stream Switch

```typescript
// End watch for current stream
if (watchEventId) {
  logWatchEnd(watchEventId);
}

// Start watch for new stream
logWatchStart(deck.next.stream.stream_id).then(id => {
  watchEventId = id;
});
```

### On Page Unload

```typescript
window.addEventListener("beforeunload", () => {
  if (watchEventId) {
    logWatchEnd(watchEventId);
  }
});
```

---

## Live Stats Script

A shell script (`live-stats.sh`) provides real-time visibility:

```bash
./live-stats.sh
```

Output:
```
📡 Live Broadcasts (5)
=======================
STREAM  BROADCASTER  LOCATION     ORIGIN      STARTED   HEARTBEAT  VIEWERS
zit56   Erik Herz    Windsor, US  cloudflare  16:45:12  18:45:12   3

👀 Current Stream Viewers (12)
============================
STREAM  VIEWER     LOCATION       STARTED
zit56   Anonymous  Delhi, IN      18:20:46

👀 Current Location Viewers (7)
===============================
VIEWER     LOCATION         STREAMS                        STARTED
Anonymous  Rennes, FR       rcdnf,a890k,bk4gm,syjwp,zit56  17:03:43
```

Viewers are deduplicated by:
- Logged-in users: one entry per user_id per stream
- Anonymous users: one entry per geo location (lat/long) per stream

---

## TikTok Live UI (January 2026)

The `/scroll` view now features a TikTok Live-style overlay with real data from the database.

### UI Components

```
┌─────────────────────────────────────────┐
│ [LIVE 🔴] [👁 1.2K]              [X]    │  ← Top bar
│                                         │
│                                   [👤]  │  ← Profile avatar
│                                   [+]   │     with follow badge
│                                   [❤️]  │  ← Like button
│                                   [💬]  │  ← Comments (mock)
│                                   [🎁]  │  ← Gift (mock)
│                                   [↗️]  │  ← Share (mock)
│                                         │
│ @username                               │  ← Creator name
│ 🇺🇸 Windsor, US                         │  ← Location with flag
│ [stream_id]                             │  ← Cyan stream ID badge
│                                         │
│               ───────                   │  ← Swipe indicator
└─────────────────────────────────────────┘
```

### Real-Time Data

Data populated from `/api/stats/greet` and `/api/stats/stream/:id/viewers`:

| Element | Data Source | Update Frequency |
|---------|-------------|------------------|
| Viewer count | `viewer_count` from greet API | Every 10 seconds |
| Broadcaster name | `user_name` from broadcast | On stream switch |
| Location | `geo_city`, `geo_country` | On stream switch |
| Country flag | Derived from `geo_country` code | On stream switch |
| Stream ID | `stream_id` | On stream switch |

### Z-Index Stacking

Critical for overlay visibility during deck transitions:

```css
.scroll-overlay {
  z-index: 100;  /* Above all deck positions */
}

.scroll-deck-current { z-index: 10; }
.scroll-deck-prev,
.scroll-deck-next { z-index: 5; }
.scroll-deck-far_prev,
.scroll-deck-far_next { z-index: 1; }
```

Without explicit z-index on the overlay, dynamically created `hang-watch` elements could stack on top, blocking UI interactions.

### Full-Width Video on Mobile

```css
#scroll-view hang-watch canvas {
  object-fit: cover;  /* Fill viewport, crop if needed */
}
```

Using `object-fit: cover` instead of `contain` ensures the video fills the full viewport width on mobile devices, cropping top/bottom as needed (TikTok-style).

### Floating Hearts Animation

Tapping the like button spawns animated hearts:

```typescript
function spawnFloatingHeart(): void {
  const heart = document.createElement("div");
  heart.className = "scroll-floating-heart";
  heart.innerHTML = "❤️";
  heart.style.setProperty("--drift", `${(Math.random() - 0.5) * 30}px`);
  floatingHeartsEl.appendChild(heart);
  setTimeout(() => heart.remove(), 2000);
}
```

```css
@keyframes float-up {
  0% { opacity: 1; transform: translateY(0) scale(1); }
  100% { opacity: 0; transform: translateY(-180px) scale(0.5); }
}
```

### TikTok Brand Colors

| Color | Hex | Usage |
|-------|-----|-------|
| TikTok Red/Pink | `#FE2C55` | LIVE badge, follow button, likes |
| TikTok Cyan | `#25F4EE` | Stream ID badge |
| White | `#FFFFFF` | Text, icons |
| Black | `#000000` | Background |

---

## References

- [MoQ Protocol Draft](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/)
- [@moq/hang source](./node_modules/@moq/hang/)
- [@moq/lite source](./node_modules/@moq/lite/)
- [WebTransport API](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport)
