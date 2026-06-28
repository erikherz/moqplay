# Using pro.moq.dev as your CDN (MoQplay Backend C)

[pro.moq.dev](https://pro.moq.dev) is a **hosted** MoQ relay run by the `moq-dev` team. Each
**project** gets its own endpoint `https://<project>.cdn.moq.dev`, its own access control, and
its own stats — **zero infrastructure for you**, but **authenticated** (unlike the open
Cloudflare/self-hosted relays). The browser connects directly (MoQplay's `static` fleet mode)
and the Worker mints a short-lived HS256 token per broadcast, signed with your project key.

This is what **moqplay.com** runs. It's the nicest of the four backends: hosted *and* access-
controlled, with no relay to operate. Each self-hoster **brings their own project key** — you
never use someone else's.

---

## 0. Prerequisites

- A deployed MoQplay app (see [cloudflare-install.md](./cloudflare-install.md)).
- A [pro.moq.dev](https://pro.moq.dev) account.

---

## 1. Create a project and download its key

1. Sign in to [pro.moq.dev](https://pro.moq.dev) and **create a project** (e.g. `myapp`).
   It becomes reachable at `https://myapp.cdn.moq.dev`.
2. **Download the project key.** It's a JWK that looks like this (a *symmetric* HMAC secret —
   `"kty":"oct"`, `"alg":"HS256"`, with a `kid`):

   ```json
   { "kty": "oct", "alg": "HS256", "k": "<secret>", "kid": "f8…07", "key_ops": ["sign","verify"] }
   ```

> **Treat the key like a password.** Anyone holding it can publish/subscribe on your project
> and run up your stats. Keep it out of git and out of the browser.

---

## 2. Store the key as a Worker secret

The key lives **server-side only**. The Worker uses it to sign per-broadcast tokens; the
browser only ever receives a short-lived token, never the key.

```bash
npx wrangler secret put MOQ_PROJECT_JWK    # paste the entire JWK file contents
```

> End users never upload anything — this is a one-time deploy step for whoever runs the app.

---

## 3. Point the app at your project

In `wrangler.jsonc`, set the fleet to your project endpoint (no code change):

```jsonc
"vars": {
  "FLEET_MODE": "static",
  "FLEET_ENDPOINT": "https://myapp.cdn.moq.dev"
}
```

`static` mode connects the browser straight to `FLEET_ENDPOINT`. Because `MOQ_PROJECT_JWK` is
set, the Worker mints an HS256 token for each broadcast (if the secret were absent, `static`
would connect token-free — that's the open Cloudflare/self-hosted backends).

---

## 4. Deploy

```bash
npm run deploy
```

---

## 5. How it works (project-rooted naming — automatic)

pro.moq.dev **roots every connection at your project**: within `myapp.cdn.moq.dev`, the relay
operates in a namespace *relative* to `myapp` and strips that root from announce interests.
MoQplay handles this for you, derived from `FLEET_ENDPOINT`:

- **Project root** = the first label of `FLEET_ENDPOINT` (`myapp.cdn.moq.dev` → `myapp`).
- **Token** authorizes the **absolute** path `myapp/<id>.hang` (what the relay checks auth against).
- **Broadcast name** on the wire is **relative** `<id>.hang` (the relay adds the root back; a
  prefixed name would never match the stripped interest, so the catalog would reset).

No hardcoding — switch projects by changing `FLEET_ENDPOINT` (and the `MOQ_PROJECT_JWK` secret).
The token claim format (`put`/`get`/`exp`) is standard [moq-token](https://github.com/moq-dev/moq);
the Worker stamps the key's own `kid` so the multi-tenant relay selects the right key.

---

## Verify

1. Open your app, **Start** a broadcast (allow camera/mic), open the share link in a second tab → video plays.
2. Check your **pro.moq.dev project dashboard** — the session shows up under the project's stats.

Browser console (success): `connected via WebTransport`, `negotiated ALPN: moq-lite-04`,
`subscribe start: … track=catalog.json`, then catalog + video flow.

---

## Troubleshooting

- **Connection fast-rejects (`AggregateError: All promises were rejected`, fast retry-backoff)** →
  the relay refused the session. Almost always the **token path**: `FLEET_ENDPOINT`'s subdomain
  must be your real project (the token authorizes `<project>/<id>.hang`). A *slow* timeout instead
  means a transport/UDP issue, not auth.
- **Connects + ALPN ok, but `subscribe error … catalog.json error=Received RESET_STREAM`** →
  publisher/subscriber broadcast-name mismatch. MoQplay's relative-name handling fixes this; if
  you've customized naming, ensure the **name is relative** (`<id>.hang`) while the **token is
  absolute** (`<project>/<id>.hang`).
- **Auth/`kid` rejection** → the token must be signed with *this project's* key; the Worker
  stamps the key's `kid` automatically (don't strip it from the JWK).
- **`MOQ_PROJECT_JWK` parse error in Worker logs** → the secret must be the full JWK JSON
  (with the `k` field), not just the `k` value.

---

## Reference

- [pro.moq.dev](https://pro.moq.dev) — the hosted relay / project dashboard
- [moq-token](https://github.com/moq-dev/moq/tree/main/rs/moq-token) — the JWT/token format
- [readme.md → "Choosing a CDN"](./readme.md) — all four backends (config, not code)
- [MEDIA-ENCRYPTION.md](./MEDIA-ENCRYPTION.md) — relay-blind media encryption (independent of the backend)
