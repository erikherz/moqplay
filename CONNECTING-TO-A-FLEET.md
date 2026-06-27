# Connecting moqplay to a TinyMoQ relay fleet

moqplay's "get a relay for this broadcast" step supports **two configurable paths**. In
both, moqplay signs the viewer/publisher access token with its **BYOK private key** and the
returned `host:port` is what the browser connects to (`?jwt=…`). The *only* difference is
the **assign endpoint** and the **credential** — so switching paths is **config, not code**:

| | **Path 1 — Direct** | **Path 2 — Brokered** |
|---|---|---|
| Who runs the fleet | you (self-hosted fleet) or a box you call yourself | a CDN operator fronts the fleet |
| `FLEET_MODE` | `direct` | `brokered` |
| `FLEET_ENDPOINT` | the relay box, e.g. `https://cdn.tinymoq.com` | the operator's broker, e.g. `https://tinymoq.com` |
| `TINYMOQ_PROVISION_KEY` | a **provisioning bearer** you choose | an operator-issued **customer token** |
| Who picks the box | moqplay (calls the box's `/assign`) | the operator (moqplay POSTs `{broadcast}`) |
| Box registration | you edit the fleet's `customers.json` | the operator does it; you skip it |

> moqplay's config knobs are its real settings. **Where they live:** on a Cloudflare
> deployment, `FLEET_ENDPOINT` + `FLEET_MODE` are `wrangler.jsonc` `vars` and the keys are
> `wrangler secret`s ([cloudflare-install.md](./cloudflare-install.md)); on Ubuntu they're
> entries in `/etc/moqplay/moqplay.env` ([ubuntu-install.md](./ubuntu-install.md)).

---

## The model: two credentials (both paths)

A moqplay deployment talks to a relay fleet using **two independent credentials** — don't
conflate them:

1. **The credential** (`TINYMOQ_PROVISION_KEY`) — what lets moqplay's *server* ask the fleet
   for a relay. In direct mode it's a **provisioning bearer**; in brokered mode it's an
   **operator-issued customer token**. Either way it's sent as `Authorization: Bearer …`.

2. **moqplay's BYOK signing keypair** — moqplay signs every viewer/publisher **access token**
   (a scoped, expiring JWT) with its **private** key (`MOQ_AUTH_PRIVATE_JWK`); the relay
   boxes validate those tokens with moqplay's **public** key (`verify_jwk`). The fleet only
   ever holds the *public* key, so it can **verify** a viewer but can **never forge a token
   or read content** — that's "relay-blind."

**BYOK is the only keying model, on both paths:** moqplay always signs with its own private
key; the fleet only ever receives the public verify key.

---

## Path 1 — Direct (self-hosted fleet, or a box you call yourself)

You run both halves: your own moqplay *and* your own TinyMoQ fleet box (installed with the
one-line TinyMoQ installer), or you call a managed box's `/assign` directly.

### On the moqplay box

```
FLEET_MODE             = direct
FLEET_ENDPOINT         = https://cdn.tinymoq.com     # your relay box
TINYMOQ_PROVISION_KEY  = <provisioning bearer you choose:  openssl rand -hex 24>
MOQ_AUTH_PRIVATE_JWK   = <your Ed25519 private JWK>   # signing; never leaves moqplay
```

You also need the **public** half of that keypair, as a JWK (with its `kid`), to register on
the fleet. `npm run keygen` generates the pair if absent — it sets `MOQ_AUTH_PRIVATE_JWK`
and prints the **public verify JWK** (never the private half); paste that into `verify_jwk`
below. To fetch it again from a running moqplay: `curl https://<moqplay>/api/pubkey`.

### On the fleet box — register moqplay as a customer

These are authoritative TinyMoQ facts:

- **The fleet is fail-closed.** Until a customer is registered, `/assign` returns **401 by
  design**.
- **Register moqplay** in `/etc/moq-autoscale/customers.json` — it needs **both** the
  matching bearer **and** moqplay's public key:

  ```json
  [
    {
      "id": "moqplay",
      "name": "MoQplay",
      "key": "<the SAME provisioning bearer you set as TINYMOQ_PROVISION_KEY>",
      "quota": 4,
      "verify_jwk": {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": "<base64url public key — from moqplay's exported public JWK>",
        "alg": "EdDSA",
        "use": "sig",
        "key_ops": ["verify"],
        "kid": "<the SAME kid as moqplay's exported public JWK>"
      }
    }
  ]
  ```

  - `key` **must be byte-for-byte identical** to moqplay's `TINYMOQ_PROVISION_KEY`.
  - `verify_jwk` is the **public half** of moqplay's signing key (never the private `d`);
    its `kid` must match the `kid` moqplay stamps on its tokens (the relay selects the
    verify key by `kid`).
  - `quota` caps this customer's concurrent relays.

- **Lock down and reload:**
  ```bash
  sudo chmod 600 /etc/moq-autoscale/customers.json
  sudo systemctl reload moq-autoscaler@<inst>
  ```
  `reload` re-reads the customer list — all you need after a `customers.json` edit. A full
  `restart` is only for changes that aren't hot-reloadable (the service binary / base config).

> **The two things to get right:** the bearer is **identical** in both places, and the
> `verify_jwk` is the **public** half of moqplay's signing key (with a matching `kid`).

---

## Path 2 — Brokered via a CDN operator

A CDN operator runs the fleet (multiple boxes) and fronts it with a **broker**. moqplay
hands the broker a broadcast and gets back a relay; the operator does the box selection.
moqplay **never sees box topology and holds no per-box secret**, so when the operator adds
or removes boxes, **moqplay's config doesn't change**.

### On the moqplay box (this is all you do)

```
FLEET_MODE             = brokered
FLEET_ENDPOINT         = https://tinymoq.com          # the OPERATOR's broker, not a box
TINYMOQ_PROVISION_KEY  = <the customer token the operator gave you>
MOQ_AUTH_PRIVATE_JWK   = <your Ed25519 private JWK>    # unchanged — BYOK as always
```

Get `FLEET_ENDPOINT` + the customer token from the operator's **cdnadmin connection-details**
when they register you. At registration you give them your **public verify JWK**
(`curl https://<moqplay>/api/pubkey`, or the printed output of `npm run keygen`); they push
it to the boxes. Your **BYOK keypair otherwise stays as-is**, and there is **no
`customers.json` edit for you to do**.

### What happens at go-live

1. moqplay POSTs `{broadcast}` to `https://tinymoq.com/cdn/assign` with the customer token.
2. The operator routes to a box and returns `{relay: "host:port"}`.
3. moqplay mints the viewer/publisher JWT (its own BYOK key) and the browser connects to
   that relay with `?jwt=…`, exactly as in direct mode.

> **This supersedes the earlier "the operator gives you a box endpoint + bearer" framing.**
> In the brokered path the endpoint is the **operator** (not a box), the credential is a
> **customer token** (not a per-box provisioning bearer), and the **operator does the box
> selection**. Path 1 (direct box + provisioning bearer) remains the self-hosted / self-
> operated option.

---

## Verify (end to end, either path)

1. Publish a **test broadcast** on your moqplay.
2. moqplay's server hits the assign endpoint with the credential — **direct:**
   `GET https://<box>/assign?broadcast=…`; **brokered:** `POST https://<operator>/cdn/assign`
   with `{broadcast}`.
3. The fleet spins up / selects a relay and returns its `host:port`.
4. Open the share URL in another browser → a viewer connects and **plays** (moqplay's BYOK
   token verified by the box against the `verify_jwk`).

If a broadcast goes live but no video plays, it's almost always: `FLEET_ENDPOINT`/`FLEET_MODE`
wrong for your path, the credential rejected (→ 401 from assign — mismatched bearer in
direct, bad/un-provisioned customer token in brokered), or the `verify_jwk`/`kid` not
matching moqplay's signing key (→ the box rejects the viewer token). Self-hosted operators
can watch relays land with `curl -u <admin> https://<fleet>/status`.

## Reference

- [cloudflare-install.md](./cloudflare-install.md) — moqplay on Cloudflare (where these settings live; BYOK key-gen script)
- [ubuntu-install.md](./ubuntu-install.md) — moqplay on a single Ubuntu VM
- `src/worker/index.ts` — the two `assignRelay` paths (`fleetMode`, `assignViaBroker`)
- `src/worker/auth/moq-token.ts` — how moqplay mints the BYOK Ed25519 tokens (and the `kid`)
- [MEDIA-ENCRYPTION.md](./MEDIA-ENCRYPTION.md) — relay-blind E2E encryption
