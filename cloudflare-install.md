# Deploying MoQplay to your own Cloudflare account

This is the step-by-step companion to the [README](./readme.md). It takes a fresh fork
from zero to a running deployment on **your** Cloudflare account and **your** domain.

> **Read this first — the relay prerequisite.** MoQplay is two halves: the **app** (a
> Cloudflare Worker — easy to deploy, covered here) and the **relay network** (where the
> media actually flows). This repo deploys the app, but **out of the box it points at the
> reference relay infrastructure** (`cdn.gpcmoq.com`), which you can't publish to. To
> stream on your own deployment you must supply a relay backend and repoint the app at it
> — see [§6 Relay backend](#6-relay-backend-required-to-actually-stream). Everything
> before §6 gets the app live (sign-in, UI, settings); §6 is what makes video flow.

---

## 0. Prerequisites

- A **Cloudflare account** with Workers, D1, and Durable Objects enabled.
- A **domain on Cloudflare** (added as a zone) that you'll serve MoQplay from.
- **Node.js 20+** and **npm**.
- A **Google Cloud** project (for OAuth sign-in).
- A **relay backend** — your own TinyMoQ boxes or another MoQ relay that speaks the token
  contract (see §6). Without this the app runs but cannot assign relays to broadcasts.

Install the CLI and dependencies:

```bash
git clone <your-fork-url> moqplay && cd moqplay
npm install
npx wrangler login          # authenticates the Wrangler CLI to your Cloudflare account
```

---

## 1. Create the D1 database

```bash
npx wrangler d1 create moqplay-db
```

This prints a `database_id`. Open `wrangler.jsonc` and set the `d1_databases` binding to
your values (keep the binding name `DB`):

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "moqplay-db",
    "database_id": "<paste-the-id-wrangler-printed>"
  }
]
```

Load the schema (fresh database — applies the full `schema.sql`):

```bash
npx wrangler d1 execute moqplay-db --remote --file=src/worker/db/schema.sql
```

> The files in `src/worker/db/migrations/` are *incremental* migrations for an existing
> database. For a brand-new deploy, `schema.sql` already contains the final shape, so you
> only need the command above. (Use `--local` instead of `--remote` to seed a local dev DB.)

Durable Objects (`CHAT_ROOMS` → `ChatRoom`, for live chat) need **no manual step** — the
`durable_objects` + `migrations` blocks already in `wrangler.jsonc` create them on first deploy.

---

## 2. Point it at your domain

In `wrangler.jsonc`, set the Worker name and your custom-domain routes:

```jsonc
"name": "your-app",
"routes": [
  { "pattern": "yourdomain.com",     "custom_domain": true },
  { "pattern": "www.yourdomain.com", "custom_domain": true }
]
```

The domain must already be a zone in the same Cloudflare account. Cloudflare provisions the
custom-domain DNS + certificate on deploy.

---

## 3. Set up Google OAuth

Sign-in uses Google OAuth. In the [Google Cloud Console](https://console.cloud.google.com/):

1. **APIs & Services → Credentials → Create credentials → OAuth client ID.**
2. Application type: **Web application.**
3. **Authorized redirect URIs** — add exactly:
   ```
   https://yourdomain.com/api/auth/google/callback
   ```
   (The callback path is fixed in the Worker: `/api/auth/{provider}/callback`. Add a
   `www.` variant too if you serve `www`.)
4. Copy the **Client ID** and **Client secret** for the next step.

> Auth only works against the deployed Worker (or `wrangler dev`), not the plain
> `npm run dev` Vite server, since the OAuth callback is a Worker route.

---

## 4. Generate the secrets

MoQplay needs the secrets below. Set each with `npx wrangler secret put <NAME>` (you'll be
prompted to paste the value):

| Secret | What it is | How to get it |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | from §3 |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | from §3 |
| `SESSION_SECRET` | signs user session cookies | `openssl rand -base64 32` |
| `MOQ_AUTH_PRIVATE_JWK` | your Ed25519 **BYOK** signing key (JSON) | `npm run keygen` (below) |
| `TINYMOQ_PROVISION_KEY` | bearer token for your relay's `/assign` API | from your relay backend (§6) |
| `RESOLVE_KEY` | *(optional)* enterprise on-net relay resolution | from your relay backend |

### Generate the BYOK key pair

The Worker signs each relay token with **your own** Ed25519 private key; the relay only
ever holds the matching **public** key. One command does it (it's idempotent — skips if a
key already exists, so it's safe to run at install):

```bash
npm run keygen      # generates if absent, sets the MOQ_AUTH_PRIVATE_JWK secret,
                    # and prints ONLY the public verify JWK (the private half is never printed)
```

It stores the **private** half as the `MOQ_AUTH_PRIVATE_JWK` Cloudflare secret and prints
the **public verify JWK** to stdout — paste that into your relay/CDN console (§6b). To
rotate later, `npm run keygen -- --force` (then re-register the new public key).

You can re-print the public verify JWK anytime from the running Worker:

```bash
curl https://yourdomain.com/api/pubkey
```

`/api/pubkey` derives the public JWK from the configured signing key and returns it as plain
JSON. It only ever exposes public material — never the private half.

- Set the **private** JWK (the line with `"d"`) as the `MOQ_AUTH_PRIVATE_JWK` secret.
- Give the **public** JWK (plus its `kid`) to your relay so it can verify your tokens
  (§6). Because the private JWK carries its own `kid`, the Worker uses it automatically —
  you do **not** need to edit the `MOQ_KID` fallback constant in `src/worker/auth/moq-token.ts`.

---

## 5. Deploy

```bash
npm run deploy   # builds dist/ and ships the Worker (vite build && wrangler deploy)
```

After this you should be able to load `https://yourdomain.com`, sign in with Google, and
change stream settings. **Broadcasting won't work yet** — that needs the relay backend.

---

## 6. Relay backend (required to actually stream)

The Worker doesn't relay media itself. On go-live it calls a **TinyMoQ fleet autoscaler**
and asks for a relay `host:port`. The fleet it points at is the `FLEET_ENDPOINT` config
value (see §6c) — it defaults to the reference fleet, which only the reference deployment
may publish to. To stream on your own deployment you must:

> If you run your own TinyMoQ fleet box too, [**CONNECTING-TO-A-FLEET.md**](./CONNECTING-TO-A-FLEET.md)
> is the full wiring guide (the bearer + BYOK `verify_jwk` registration on the fleet's
> `customers.json`). The steps below are the moqplay-side summary.

### 6a. Stand up a relay

Run your own [TinyMoQ](https://tinymoq.com) relay box(es) — or another MoQ relay that
implements the same control + token contract: a sticky `/assign` API (bearer-authed by
`TINYMOQ_PROVISION_KEY`) that returns a relay `host:port`, and EdDSA (Ed25519) token
verification keyed by `kid`. *(A managed option is on the roadmap — see the README's
**MoQcdn exchanges** section.)*

### 6b. Register your BYOK public key with the relay

Give the relay the **public** JWK from §4 (with its `kid`) as a `verify_jwk`. The relay
trusts tokens your Worker signs without ever holding a signing key.

### 6c. Point the app at your fleet (config, not code)

This is a settings change — **no source edits**. Set the fleet base URL in `wrangler.jsonc`:

```jsonc
"vars": {
  "FLEET_ENDPOINT": "https://cdn.yourfleet.com"
}
```

The Worker calls `/assign` + `/release` on that endpoint and derives its SSRF allowlist
from it (the fleet host plus sibling boxes under the same registrable domain, e.g.
`usw.yourfleet.com`), so multi-box fleets work without code changes. Then make sure the
matching secret is set (§4):

- `TINYMOQ_PROVISION_KEY` — the bearer the fleet operator registered for your tenant.

That's the whole "point me at a CDN" config: **`FLEET_ENDPOINT`** + **`TINYMOQ_PROVISION_KEY`**
+ your **BYOK keypair** (§4, public half registered in §6b). A new operator gives you an
endpoint and a bearer; you set those two and deploy.

*(One legacy spot is still hardcoded: `FALLBACK_RELAYS` in `src/main.ts`, the Safari
WebSocket fallback host. Native WebTransport has largely retired that path; change it only
if you still support the WS fallback.)*

### 6d. (Optional) Change the broadcast namespace

The broadcast name is `moqplay.com/{streamId}.hang`, set by `broadcastName()` in
`src/worker/index.ts` and `NAMESPACE_PREFIX` in `src/main.ts`. Publisher and viewer just
have to agree, so it works as-is, but you'll likely want your own namespace prefix —
especially if multiple tenants share a relay.

Redeploy (`npm run deploy`) after these edits. With a reachable relay, your BYOK public key
registered, and `TINYMOQ_PROVISION_KEY` set, broadcasting and watching will work end to end.

---

## Troubleshooting

- **Sign-in loops / `oauth_denied`** — the redirect URI in Google Cloud must match
  `https://yourdomain.com/api/auth/google/callback` exactly (scheme, host, path).
- **"encrypted but no content key / can't go live"** — encryption is mandatory; this means
  the broadcast row didn't get a content key. Check the Worker logs (`npx wrangler tail`).
- **Goes live but no video** — almost always the relay backend (§6): `FLEET_ENDPOINT` still
  points at the default fleet, `TINYMOQ_PROVISION_KEY` is missing/wrong, or your BYOK public key
  isn't registered with the relay (token rejected).
- **D1 errors on first load** — you skipped §1; run the `schema.sql` execute command.

## Reference

- [README](./readme.md) — overview, architecture, CDN options
- [MEDIA-ENCRYPTION.md](./MEDIA-ENCRYPTION.md) — relay-blind E2E encryption design
- [TinyMoQ](https://tinymoq.com) — relay CDN
