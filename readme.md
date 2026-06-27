# MoQplay

An open-source, self-hostable live streaming app built on **MoQ (Media over QUIC)**. Deploy your own copy to Cloudflare in minutes, point it at your own domain, brand it as your own, and stream sub-second live video peer-to-relay-to-peer in the browser.

The reference deployment runs at **[moqplay.com](https://moqplay.com)** — but the whole point is that you don't have to use it. Fork it, deploy it, and run your own.

## What you get

- **Ultra-low-latency live video** in the browser using the [@moq](https://www.npmjs.com/org/moq) (`@moq/publish` / `@moq/watch`) web components over the MoQ `moq-lite-04` transport.
- **One-command Cloudflare deploy** — the app is a single Cloudflare Worker that serves the static frontend *and* runs the API (auth, stream provisioning, relay-token minting).
- **Your domain, your branding** — change a couple of config values and it's your product, not MoQplay.
- **Relay-blind end-to-end encryption** — media is encrypted in the browser; the relay only ever forwards ciphertext it can't read (see [MEDIA-ENCRYPTION.md](./MEDIA-ENCRYPTION.md)).
- **Bring-your-own-CDN** — plug in the [TinyMoQ](https://tinymoq.com) relay CDN today, with **MoQcdn exchanges** on the roadmap (see below).

## Architecture

```
┌─────────────┐                                            ┌─────────────┐
│   Browser   │ ───▶  MoQ relay (TinyMoQ CDN box)  ◀─────  │   Browser   │
│ (Publisher) │  QUIC   host:port from /assign      QUIC   │  (Watcher)  │
│ hang-publish│                                            │  hang-watch │
└─────────────┘                                            └─────────────┘
       │                                                          │
       │            ┌──────────────────────────────┐             │
       └──────────▶ │   MoQplay Cloudflare Worker   │ ◀───────────┘
       static +     │  • serves frontend (dist/)    │   /api/* (auth,
       /api/*       │  • Google OAuth + sessions    │   provision,
                    │  • mints relay tokens (BYOK)  │   relay routing)
                    │  • D1 (streams) + DO (chat)   │
                    └───────────────┬──────────────┘
                                    │ /assign · /route  (control API)
                                    ▼
                          TinyMoQ CDN autoscaler
                       (your relay boxes / exchange)
```

How a broadcast flows:

1. The browser asks the Worker to go live for a stream ID.
2. The Worker calls the TinyMoQ autoscaler (`/assign`), which spins up / sticks a relay and returns its `host:port`.
3. The Worker mints a relay token. MoQplay uses **BYOK** — it signs its own Ed25519 token with its tenant key, so the relay trusts it without sharing a secret.
4. The publisher connects directly to the assigned relay over QUIC; viewers are routed to the same (or a co-located) relay via `/route`.

The Worker is the only managed piece. The relays are supplied by whatever CDN you configure.

## Tech stack

- **Frontend**: Vite + `@moq/publish` / `@moq/watch` web components (`<moq-publish>` / `<moq-watch>`)
- **Backend**: Cloudflare Workers, D1 (stream metadata), Durable Objects (`ChatRoom` chat)
- **Auth**: Google OAuth + signed sessions
- **Protocol**: MoQ `moq-lite-04` (negotiated by `@moq/net`)
- **Relay tokens**: Ed25519 BYOK (own tenant key id)

> **Version pin:** The `@moq/*` deps are pinned to exact versions (`@moq/publish@0.2.15`,
> `@moq/watch@0.2.17`, `@moq/web-transport-ws@0.1.2`), and `package.json` `overrides` lock
> the patch-critical transitive deps (`@moq/net@0.1.5`, `@moq/hang@0.2.11`). This is
> deliberate: the build-time media-crypto patch in `vite.config.ts` matches source strings
> in `@moq/net` (`track.js`) and `@moq/hang` (`container/legacy.js`, `consumer.js`), and the
> wire protocol (`moq-lite-04`) must match the relay. A version bump is safe only when the
> patch still applies (the build fails closed if a seam moves) **and** the relay speaks the
> same protocol — so upgrade the app and relay together, not independently.
>
> The legacy `@kixelated/hang` package is **deprecated** (it was renamed to `@moq/hang` and
> split into `@moq/publish` / `@moq/watch`); MoQplay already uses the current `@moq/*` packages.

---

## Deploy your own

> **Full walkthroughs:** [**cloudflare-install.md**](./cloudflare-install.md) is the
> complete step-by-step guide for the managed (Cloudflare) path — D1 setup, OAuth,
> generating the BYOK key, the relay backend. To run the web app (app + DB + chat) on a
> single Ubuntu VM instead of Workers — pointing at the same relay backend — see
> [**ubuntu-install.md**](./ubuntu-install.md). The summary below is the overview.

### Requirements

- **Cloudflare account** (Workers, D1, Durable Objects)
- **Node.js** 20+
- A relay CDN to point at (see [Choosing a CDN](#choosing-a-cdn))

### 1. Install and run locally

```bash
npm install
npm run dev      # Vite dev server on localhost:3000
```

### 2. Make it yours — domain & branding

**Domain** — edit `wrangler.jsonc`:

```jsonc
"name": "your-app",
"routes": [
  { "pattern": "yourdomain.com",     "custom_domain": true },
  { "pattern": "www.yourdomain.com", "custom_domain": true }
]
```

Also update the D1 binding (`database_name` / `database_id`) to your own database.

**Branding** — the visible name lives in the frontend:

- `index.html` — page `<title>` and the `<h1>` brand mark
- `src/main.ts` / `src/worker/index.ts` — the broadcast namespace (`yourdomain.com/{streamId}.hang`) and any UI strings

Swap the logo, colors, and footer links to taste — it's a normal Vite frontend.

### 3. Configure secrets

Set these as Worker secrets (`npx wrangler secret put <NAME>`):

| Secret | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth sign-in |
| `SESSION_SECRET` | Signs user sessions |
| `MOQ_AUTH_PRIVATE_JWK` | Your Ed25519 BYOK key for minting relay tokens |
| `TINYMOQ_PROVISION_KEY` | Tenant bearer for the TinyMoQ autoscaler (`/assign`) |
| `RESOLVE_KEY` | *(optional)* enterprise on-net relay resolution |

### 4. Deploy

```bash
npm run deploy   # builds dist/ and ships the Worker to Cloudflare
```

---

## Choosing a CDN

MoQplay separates the **app** (your Worker) from the **relay network** (the CDN). You decide where the media flows.

### Option A — TinyMoQ CDN (available today)

[TinyMoQ](https://tinymoq.com) is a relay CDN: each box is its own autoscaler exposing a sticky, idempotent `/assign` control API keyed by the broadcast name. The Worker calls it to get a relay `host:port` per broadcast, with geo-routing so publishers land on a nearby box and viewers co-locate on the publisher's box.

To use it, run (or rent) TinyMoQ relay boxes, then point the Worker's autoscaler host at them and set `TINYMOQ_PROVISION_KEY`. This is what the reference `moqplay.com` deployment uses.

### Option B — MoQcdn exchanges *(roadmap — stand by)*

The next step is **MoQcdn**: a concept for *exchanges* where relay capacity is federated across providers rather than coming from a single operator — think of it as a marketplace/peering layer for MoQ relays.

- **[moqcdnx.com](https://moqcdnx.com)** — the MoQcdn exchange concept and platform *(planned)*.
- **[moqcdn.net](https://moqcdn.net)** — the first exchange, a production deployment of TinyMoQ technology *(planned)*.

When this lands, a MoQplay deployment will be able to source relays from an exchange instead of pinning to one operator's boxes. Details to follow — this section is a placeholder for the work in progress.

---

## Usage

### Stream-based sessions

Each session uses a unique short stream ID for isolation:

- **Visit your site** → auto-generates a stream (e.g. `https://yourdomain.com/ab3x9`)
- **Share the URL** → others open it to watch
- **"+ New Stream"** → creates a fresh stream

Each stream ID maps to a unique namespace (`yourdomain.com/{streamId}.hang`) on the relay, preventing conflicts between sessions.

### Broadcasting

1. Open your site in Chrome/Edge/Firefox.
2. A unique stream ID is generated automatically.
3. Click **Start** in the Broadcast section and allow camera/microphone.
4. Share the URL with viewers.

### Watching

1. Open the shared URL.
2. The stream begins playing automatically (click play if needed).

---

## Browser support

- Chrome 97+, Edge 97+, Firefox 114+ — native WebTransport
- Safari 26.4+ — native WebTransport ([added in Safari 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/), March 2026)

## Links

- [moqplay.com](https://moqplay.com) — reference deployment
- [cloudflare-install.md](./cloudflare-install.md) — step-by-step deploy guide (managed / Cloudflare)
- [ubuntu-install.md](./ubuntu-install.md) — run the web app on a single Ubuntu VM (same relay backend)
- [CONNECTING-TO-A-FLEET.md](./CONNECTING-TO-A-FLEET.md) — connect moqplay to a TinyMoQ fleet (direct or brokered; BYOK)
- [TinyMoQ](https://tinymoq.com) — relay CDN
- [MoQ Protocol](https://moq.dev/)
- [Cloudflare MoQ Docs](https://developers.cloudflare.com/moq/)
