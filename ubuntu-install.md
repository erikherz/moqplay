# Self-hosting MoQplay on a single Ubuntu VM

This is the single-box alternative to [cloudflare-install.md](./cloudflare-install.md). It
takes one clean Ubuntu server and runs the **whole stack** — app, database, chat, and the
MoQ relay — on that one machine. No Cloudflare account required.

> **Be honest with yourself about the scope.** Cloudflare gives you four managed things for
> free: the Worker runtime, the D1 database, Durable Objects (chat), and the relay network.
> On a bare VM you provide all four. The OS packages (nginx, certbot, Node, SQLite) are a
> quick `apt` away — but the app currently targets the **Workers runtime**, so a **port to
> Node** is real work (a few well-defined shims, described in [Phase 3](#phase-3--port-the-app-to-node)).
> The relay ([Phase 2](#phase-2--the-moq-relay)) is the part to get right first.

Target: a working `https://yourdomain.com` where you can sign in, broadcast, and watch —
all served from one box. Keep it simple and light: **SQLite** for the DB, an **in-process
WebSocket** server for chat, **one** relay process.

---

## Architecture (one box)

```
                          one Ubuntu VM  →  yourdomain.com
┌──────────────────────────────────────────────────────────────────────────┐
│  nginx        TCP 80/443  (TLS via certbot)                                │
│   ├── /              → static dist/ (the built frontend)                   │
│   ├── /api/*         → reverse-proxy to the Node app (127.0.0.1:8787)      │
│   └── /api/chat/*    → reverse-proxy WITH WebSocket upgrade → Node app      │
│                                                                            │
│  Node app     127.0.0.1:8787   [ported Worker]                             │
│   ├── Google OAuth + sessions, stream settings, stats                      │
│   ├── SQLite (better-sqlite3)            ← replaces D1                      │
│   ├── in-process ws chat rooms           ← replaces Durable Objects        │
│   ├── mints Ed25519 BYOK relay tokens                                      │
│   └── "assign" → returns the LOCAL relay host:port (no autoscaler)         │
│                                                                            │
│  moq-relay    UDP 443 (QUIC / WebTransport, its OWN TLS cert)              │
│   └── verifies BYOK Ed25519 tokens by kid; enforces put/get + exp          │
└──────────────────────────────────────────────────────────────────────────┘
```

**Key transport fact:** WebTransport runs over **HTTP/3 / QUIC = UDP**, which nginx does
**not** reverse-proxy. So the relay terminates its own TLS directly on a **UDP** port; nginx
only handles the TCP app traffic. Both can share the same Let's Encrypt certificate.

---

## What changes from the Cloudflare build

| Cloudflare piece | Single-box replacement |
| --- | --- |
| Worker runtime | Node 20+ HTTP server wrapping the logic in `src/worker/index.ts` |
| `env.ASSETS` (static assets) | nginx serves `dist/` directly |
| `env.DB` (D1) | **SQLite** via `better-sqlite3` + a thin `.prepare().bind().first()/all()/run()` adapter |
| `env.CHAT_ROOMS` (Durable Object, `chat-room.ts`) | in-process `ws` server, `Map<streamId, room>`, in-memory history (last 50) |
| `request.cf` geolocation | stub to `null`s (it only feeds stats); add MaxMind GeoLite2 later if wanted |
| TinyMoQ `/assign` autoscaler | static: return the local relay's `host:port` |
| `crypto.subtle` / `crypto.getRandomValues` | Node's global WebCrypto (Ed25519 works on Node 20+) — no change |
| Worker secrets | a `.env` file loaded by the service (systemd `EnvironmentFile`) |

Everything else (auth flow, token minting, encryption, settings, the whole frontend) is
unchanged — it's the same `dist/` bundle.

---

## Phase 0 — provision the VM

A small VM is fine to start (1–2 vCPU, 2 GB RAM). You need:

- A **domain** with an **A record** pointing at the VM's public IP.
- Inbound firewall: **TCP 80, TCP 443**, and **UDP 443** (the QUIC/WebTransport port —
  this is the one everybody forgets).

```bash
sudo apt update && sudo apt upgrade -y
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp        # QUIC / WebTransport — required for media
sudo ufw enable
```

---

## Phase 1 — system packages

```bash
# nginx + certbot
sudo apt install -y nginx
sudo snap install --classic certbot && sudo ln -sf /snap/bin/certbot /usr/local/bin/certbot

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# SQLite + build toolchain (better-sqlite3 compiles a native addon)
sudo apt install -y sqlite3 build-essential python3
```

That's the whole "DB software" footprint: **SQLite** is a file, not a server — light, and a
near-exact match for D1 (which is SQLite under the hood), so `schema.sql` applies verbatim.

---

## Phase 2 — the MoQ relay

This is the part to nail first; without it nothing streams. You need a **MoQ relay** that:

1. Speaks the **same draft as the client**. The app pins `@kixelated/hang@0.3.12`
   (**draft-07**) — see the README's Interoperability note. Your relay build must match;
   a newer draft-14 relay won't connect. (This is exactly why the reference Linode/TinyMoQ
   boxes ran a pinned, patched `moq-relay`.)
2. **Verifies BYOK Ed25519 tokens.** It needs your **public** JWK (with its `kid`)
   registered as a verify key, and must enforce the `put`/`get` path scopes + `exp` from
   the token (the contract is documented inline in `src/worker/auth/moq-token.ts`).
3. **Terminates TLS on UDP** with your domain's certificate (from Phase 4).

Concretely:

- Build or obtain a `moq-relay` compatible with the above (start from
  [`kixelated/moq-rs`](https://github.com/kixelated/moq-rs) at a draft-07-compatible
  revision, or the TinyMoQ relay tech). This is the **integration risk** — budget time here.
- Configure it to bind `0.0.0.0:443/udp`, present the Let's Encrypt cert/key, and trust
  your BYOK **public** JWK by `kid`.
- Run it under systemd (see Phase 4) so it restarts on boot/crash.

> Single-box simplification: the Cloudflare build calls a TinyMoQ **autoscaler** that
> spins relays up/down and hands back a `host:port`. You have exactly one relay, so there's
> no autoscaler — the Node app just returns `yourdomain.com:443` (Phase 3).

---

## Phase 3 — port the app to Node

`src/worker/index.ts` is written for the Workers runtime. Wrap the same logic in a Node
server. The shims are small and well-bounded:

1. **HTTP entry.** Use `node:http` (or a tiny framework) listening on `127.0.0.1:8787`.
   Translate Node `req`/`res` ↔ the Web `Request`/`Response` the handler already uses
   (WHATWG `Request`/`Response` exist globally in Node 20+).

2. **D1 → SQLite adapter.** D1 calls are `env.DB.prepare(sql).bind(...).first() / .all() / .run()`.
   Wrap `better-sqlite3` to expose the same shape:
   ```js
   import Database from "better-sqlite3";
   const db = new Database("/var/lib/moqplay/moqplay.db");
   export const DB = {
     prepare(sql) {
       const stmt = db.prepare(sql);
       let args = [];
       const api = {
         bind: (...a) => { args = a; return api; },
         first: async () => stmt.get(...args) ?? null,
         all:   async () => ({ results: stmt.all(...args) }),
         run:   async () => stmt.run(...args),
       };
       return api;
     },
   };
   ```
   Apply the schema once: `sqlite3 /var/lib/moqplay/moqplay.db < src/worker/db/schema.sql`.

3. **Durable Object chat → in-process `ws`.** `chat-room.ts` is a simple broadcast room:
   every socket gets every message, the last 50 are replayed to late joiners, with a light
   per-socket throttle. Replace it with the `ws` package and a `Map<streamId, { sockets, history }>`.
   Mount it on the same `/api/chat/:streamId` route nginx upgrades. (Single box = no
   cross-instance coordination, so this is simpler than the DO.)

4. **`env.ASSETS` → nginx.** Drop the asset-serving branch; nginx serves `dist/` (Phase 4).

5. **Geo.** Replace the `request.cf` block with `null`s (stats-only). Optional: add MaxMind
   GeoLite2 later.

6. **Static "assign".** Replace the autoscaler HTTP call with a constant returning your
   relay address (e.g. `{ relay: "yourdomain.com:443" }`); keep the BYOK token-minting path
   exactly as-is. (No `TINYMOQ_PROVISION_KEY` needed in single-box mode.)

7. **Env/secrets.** Read from `process.env` (loaded from `/etc/moqplay/moqplay.env`):
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `MOQ_AUTH_PRIVATE_JWK`.
   Generate them exactly as in [cloudflare-install.md §4](./cloudflare-install.md#4-generate-the-secrets)
   (the same Ed25519 key-gen script — set the **private** JWK here, register the **public**
   one with your relay in Phase 2).

Build the frontend once and on every update:

```bash
npm install
npm run build      # emits dist/
```

---

## Phase 4 — nginx, TLS, and services

**1. Get a certificate** (point DNS at the box first):

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

This yields `/etc/letsencrypt/live/yourdomain.com/{fullchain.pem,privkey.pem}` — used by
**both** nginx and the relay. Certbot installs an auto-renew timer; add a deploy hook to
restart the relay after renewal.

**2. nginx site** (`/etc/nginx/sites-available/moqplay`):

```nginx
server {
  listen 443 ssl;
  server_name yourdomain.com www.yourdomain.com;

  ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

  root /var/www/moqplay/dist;          # the built frontend
  index index.html;

  # API → Node app
  location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    # WebSocket upgrade (live chat lives under /api/chat/)
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1h;
  }

  # SPA fallback for stream URLs like /ab3x9
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/moqplay /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**3. systemd services.**

`/etc/systemd/system/moqplay-app.service`:

```ini
[Unit]
Description=MoQplay Node app
After=network.target

[Service]
WorkingDirectory=/opt/moqplay
EnvironmentFile=/etc/moqplay/moqplay.env
ExecStart=/usr/bin/node server.mjs      # your Node entry from Phase 3
Restart=always
User=moqplay

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/moq-relay.service` — runs the relay on UDP 443 with the certs from
above (exact `ExecStart` depends on your relay build from Phase 2).

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now moqplay-app moq-relay
```

---

## Phase 5 — Google OAuth

Same as Cloudflare, with your domain. In the
[Google Cloud Console](https://console.cloud.google.com/) create a **Web application**
OAuth client and set the **Authorized redirect URI** to exactly:

```
https://yourdomain.com/api/auth/google/callback
```

Put the client ID/secret in `/etc/moqplay/moqplay.env`.

---

## Verification

1. `https://yourdomain.com` loads and Google sign-in completes (check `journalctl -u moqplay-app`).
2. Start a broadcast in Chrome → it goes live (the app mints a token and points the
   publisher at `yourdomain.com:443`).
3. Open the share URL in another browser/tab → video plays, the green **Relay-blind**
   pill shows (encryption is mandatory, decrypt succeeded end to end).
4. Live chat round-trips between the two tabs.

## Troubleshooting

- **Goes live but no video** — almost always the relay or UDP: confirm **UDP 443** is open
  end-to-end, the relay is running (`systemctl status moq-relay`), it presents a valid cert,
  and it **trusts your BYOK public key by `kid`** (a rejected token = silent no-media).
- **Draft mismatch** — if the relay build isn't draft-07-compatible, the client won't
  connect at all. Match the relay to `@kixelated/hang@0.3.12`.
- **Chat doesn't connect** — the nginx `Upgrade`/`Connection` headers must be set on
  `/api/` (above), or the WebSocket handshake fails.
- **Sign-in loops** — the Google redirect URI must match `…/api/auth/google/callback` exactly.
- **DB errors** — apply `schema.sql` to the SQLite file and ensure the `moqplay` user can
  write to `/var/lib/moqplay/`.

## Reference

- [cloudflare-install.md](./cloudflare-install.md) — the managed (Cloudflare) path; shares the secret/key steps
- [README](./readme.md) — architecture, CDN options
- `src/worker/auth/moq-token.ts` — the relay token contract (BYOK Ed25519) your relay must honor
- [MEDIA-ENCRYPTION.md](./MEDIA-ENCRYPTION.md) — relay-blind E2E encryption (unchanged on self-host)
- [kixelated/moq-rs](https://github.com/kixelated/moq-rs) — reference moq-relay
