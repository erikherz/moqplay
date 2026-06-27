# Self-hosting the MoQplay web app on a single Ubuntu VM

This is the single-box alternative to [cloudflare-install.md](./cloudflare-install.md). It
runs the **MoQplay web app** — the exact tier Cloudflare hosts — on one Ubuntu server
instead of on Workers. It points at the **same relay backend** the Cloudflare deployment
uses; the relay is not part of this box (just as it isn't part of the Cloudflare Worker).

> **Scope.** Cloudflare hosts three things for you: the Worker runtime, the D1 database,
> and Durable Objects (chat). This guide provides those three on a plain VM. The **relay
> backend is unchanged** — the app calls the same autoscaler (`/assign`) and mints the same
> BYOK tokens it does on Cloudflare. (If you don't already have a relay backend to point
> at, that's the same prerequisite either way — see
> [cloudflare-install.md §6](./cloudflare-install.md#6-relay-backend-required-to-actually-stream).)

Target: a working `https://yourdomain.com` where you can sign in, broadcast, and watch —
served from one box, streaming through your existing relay. Keep it simple and light:
**SQLite** for the DB, an **in-process WebSocket** server for chat.

---

## Architecture (one box + the existing relay)

```
            one Ubuntu VM  →  yourdomain.com                external (unchanged)
┌──────────────────────────────────────────────────┐
│  nginx       TCP 80/443  (TLS via certbot)         │
│   ├── /           → static dist/ (built frontend)  │
│   ├── /api/*      → reverse-proxy → Node app        │
│   └── /api/chat/* → proxy WITH WebSocket upgrade    │
│                                                    │
│  Node app    127.0.0.1:8787  [ported Worker]       │      ┌────────────────────┐
│   ├── OAuth + sessions, stream settings, stats     │      │  relay backend      │
│   ├── SQLite (better-sqlite3)   ← replaces D1       │ ───▶ │  (TinyMoQ / your    │
│   ├── in-process ws chat        ← replaces DO       │/assign│  autoscaler) —     │
│   ├── mints Ed25519 BYOK relay tokens              │      │  SAME as Cloudflare │
│   └── calls /assign for the relay host:port        │      └─────────┬──────────┘
└──────────────────────────────────────────────────┘                │ QUIC
                                                                      ▼
                            Browser ────────── QUIC / WebTransport ───┘
                            (publisher / viewer connect DIRECTLY to the relay)
```

The browser connects to the **relay** directly over QUIC, exactly as on Cloudflare. The
Ubuntu box only serves the web app over TCP — it never carries media — so this box needs
**no UDP/QUIC listener** and no relay software.

---

## What changes from the Cloudflare build

| Cloudflare piece | Single-box replacement |
| --- | --- |
| Worker runtime | Node 20+ HTTP server wrapping the logic in `src/worker/index.ts` |
| `env.ASSETS` (static assets) | nginx serves `dist/` directly |
| `env.DB` (D1) | **SQLite** via `better-sqlite3` + a thin `.prepare().bind().first()/all()/run()` adapter |
| `env.CHAT_ROOMS` (Durable Object, `chat-room.ts`) | in-process `ws` server, `Map<streamId, room>`, in-memory history (last 50) |
| `request.cf` geolocation | stub to `null`s (it only feeds stats); add MaxMind GeoLite2 later if wanted |
| Worker secrets | a `.env` file loaded by the service (systemd `EnvironmentFile`) |

**Unchanged from Cloudflare:** the relay routing (`/assign` call), BYOK Ed25519 token
minting, the auth flow, encryption, stream settings, and the entire frontend (`dist/`). If
you reuse the same `MOQ_AUTH_PRIVATE_JWK`, your BYOK public key is already registered with
the relay — nothing to re-register.

---

## Phase 0 — provision the VM

A small VM is fine to start (1–2 vCPU, 2 GB RAM). You need:

- A **domain** with an **A record** pointing at the VM's public IP.
- Inbound firewall: **TCP 80 and TCP 443** only. (No UDP — media never touches this box.)

```bash
sudo apt update && sudo apt upgrade -y
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
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

## Phase 2 — port the app to Node

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

4. **`env.ASSETS` → nginx.** Drop the asset-serving branch; nginx serves `dist/` (Phase 3).

5. **Geo.** Replace the `request.cf` block with `null`s (stats-only). Optional: add MaxMind
   GeoLite2 later.

6. **Relay routing — keep it.** Leave the `/assign` call and BYOK token-minting **exactly
   as on Cloudflare**. It already points at your relay backend; nothing to change here.

7. **Env/secrets.** Read from `process.env` (loaded from `/etc/moqplay/moqplay.env`) — the
   **same set as Cloudflare**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`,
   `MOQ_AUTH_PRIVATE_JWK`, `TINYMOQ_PROVISION_KEY` (and `RESOLVE_KEY` if you use the
   enterprise path). Generate the first four exactly as in
   [cloudflare-install.md §4](./cloudflare-install.md#4-generate-the-secrets); reuse the
   same values as your Cloudflare deployment if you want them to share a relay tenant + key.

Build the frontend once and on every update:

```bash
npm install
npm run build      # emits dist/
```

---

## Phase 3 — nginx, TLS, and the service

**1. Get a certificate** (point DNS at the box first):

```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

Certbot installs an auto-renew timer; no extra wiring needed (only nginx uses the cert).

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

**3. systemd service** — `/etc/systemd/system/moqplay-app.service`:

```ini
[Unit]
Description=MoQplay Node app
After=network.target

[Service]
WorkingDirectory=/opt/moqplay
EnvironmentFile=/etc/moqplay/moqplay.env
ExecStart=/usr/bin/node server.mjs      # your Node entry from Phase 2
Restart=always
User=moqplay

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now moqplay-app
```

---

## Phase 4 — Google OAuth

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
2. Start a broadcast in Chrome → it goes live (the app mints a token and gets a relay
   `host:port` from `/assign`).
3. Open the share URL in another browser/tab → video plays through the relay, the green
   **Relay-blind** pill shows (encryption is mandatory, decrypt succeeded end to end).
4. Live chat round-trips between the two tabs.

## Troubleshooting

- **Goes live but no video** — this is the relay path, same as on Cloudflare: confirm
  `TINYMOQ_PROVISION_KEY` is set and the relay backend is reachable from the box (the app's
  `/assign` call), and that the BYOK key the app signs with is trusted by the relay.
- **Chat doesn't connect** — the nginx `Upgrade`/`Connection` headers must be set on
  `/api/` (above), or the WebSocket handshake fails.
- **Sign-in loops** — the Google redirect URI must match `…/api/auth/google/callback` exactly.
- **DB errors** — apply `schema.sql` to the SQLite file and ensure the `moqplay` user can
  write to `/var/lib/moqplay/`.

## Reference

- [cloudflare-install.md](./cloudflare-install.md) — the managed (Cloudflare) path; shares the secret/key + relay-backend steps
- [README](./readme.md) — architecture, CDN options
- `src/worker/auth/moq-token.ts` — the relay token contract (BYOK Ed25519) the relay honors
- [MEDIA-ENCRYPTION.md](./MEDIA-ENCRYPTION.md) — relay-blind E2E encryption (unchanged on self-host)
