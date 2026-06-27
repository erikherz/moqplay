# Connecting a self-hosted moqplay to a self-hosted TinyMoQ relay fleet

**Path 1 — you operate both halves.** You run your own moqplay deployment *and* your own
TinyMoQ fleet box (installed with the one-line TinyMoQ installer). This doc wires the two
together. (For the managed alternative — a TinyMoQ CDN that registers you and hands you the
settings — see [the managed path](#managed-path-alternative) at the end.)

> moqplay's config knob names below are its real settings. **Where they live:** on a
> Cloudflare deployment, `FLEET_ENDPOINT` is a `wrangler.jsonc` `var` and the two keys are
> `wrangler secret`s (see [cloudflare-install.md](./cloudflare-install.md)); on an Ubuntu
> deployment they're entries in `/etc/moqplay/moqplay.env` (see
> [ubuntu-install.md](./ubuntu-install.md)). The values are identical either way.

---

## The model: two separate credentials

A moqplay deployment talks to a relay fleet using **two independent credentials** — don't
conflate them:

1. **Provisioning bearer** — a shared secret that lets moqplay's *server* call the fleet's
   `/assign` ("give me a relay for this broadcast"). It authorizes provisioning and
   identifies the customer. Same string on both sides.

2. **moqplay's BYOK signing keypair** — moqplay signs every viewer/publisher **access
   token** (a scoped, expiring JWT) with its **private** key. The fleet validates those
   tokens with moqplay's **public** key. The fleet only ever holds the *public* key, so it
   can **verify** a viewer but can **never forge a token or read content** — that's what
   "relay-blind" means.

**BYOK is the only keying model here:** moqplay always signs with its own private key, and
the fleet only ever receives the public verify key.

```
   moqplay (your server)                              TinyMoQ fleet box
   ─────────────────────                              ─────────────────
   FLEET_ENDPOINT ───────── POST /assign (bearer) ──▶ customers.json: key == bearer?  ──▶ spawn relay
   MOQ_AUTH_PRIVATE_JWK ─── signs viewer/pub JWT ──▶  customers.json: verify_jwk (public)
                                                       verifies JWT by kid, enforces scope+exp
   (private key NEVER leaves moqplay)                  (holds ONLY the public key)
```

---

## On the moqplay box — three settings

1. **Fleet endpoint** — where moqplay calls `/assign`. Set **`FLEET_ENDPOINT`** to your
   fleet host, e.g.:
   ```
   FLEET_ENDPOINT = https://cdn.tinymoq.com
   ```

2. **Provisioning bearer** — a strong secret *you* choose. Generate one:
   ```bash
   openssl rand -hex 24
   ```
   Set it as moqplay's provisioning-bearer setting, **`TINYMOQ_PROVISION_KEY`**. You'll
   paste this *same* string into the fleet's customer list below.

3. **Signing keypair** — moqplay must have its Ed25519 keypair. The **private** JWK stays
   in moqplay as **`MOQ_AUTH_PRIVATE_JWK`** (signing); you also need the **public** half,
   exported as a JWK, to give the fleet.

   If you've already deployed moqplay you have this keypair — keep the public JWK you
   generated. If not, generate one now: the Node script in
   [cloudflare-install.md §4](./cloudflare-install.md#generate-the-byok-key-pair) prints
   both halves and the `kid` (or use TinyMoQ's `moq-token-cli generate`). Result:
   - **private JWK** (has `"d"`) → `MOQ_AUTH_PRIVATE_JWK`
   - **public JWK** (has `"x"` + `kid`, no `"d"`) → the fleet's `verify_jwk` (next section)

---

## On the fleet box — register moqplay as a customer

These are authoritative TinyMoQ facts:

- **The fleet is fail-closed.** Until a customer is registered, `/assign` returns **401 by
  design** — an unregistered bearer gets nothing.

- **Register the moqplay customer** in `/etc/moq-autoscale/customers.json`. The entry needs
  **both** the matching bearer **and** moqplay's public key:

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

  - `key` is the provisioning bearer — it **must be byte-for-byte identical** to moqplay's
    `TINYMOQ_PROVISION_KEY`.
  - `verify_jwk` is the **public half** of moqplay's signing key (never the private `d`).
    Its `kid` must match the `kid` moqplay stamps on its tokens, because the relay selects
    the verify key by `kid`.
  - `quota` caps this customer's concurrent relays.

- **Lock it down and reload:**
  ```bash
  sudo chmod 600 /etc/moq-autoscale/customers.json
  sudo systemctl reload moq-autoscaler@<inst>
  ```
  `reload` re-reads the customer list — that's all you need after editing `customers.json`.
  A full `restart` is only needed for changes that aren't hot-reloadable (the service binary
  or its base config), not for customer edits.

> **The two things to get right:** the bearer is **identical** in both places, and the
> `verify_jwk` is the **public** half of moqplay's signing key (with a matching `kid`).

---

## Verify (end to end)

1. Publish a **test broadcast** on your moqplay.
2. moqplay's server calls `https://<fleet>/assign` with the provisioning bearer.
3. The fleet (customer registered, bearer matches) spins up a **dedicated relay** for the
   broadcast and returns its `host:port`.
4. Open the share URL in another browser → a viewer connects and **plays**. moqplay minted
   that viewer a token signed with its private key; the relay verified it against the
   `verify_jwk`.

Watch it land on the fleet:
```bash
curl -u <admin> https://<fleet>/status
```

If a broadcast goes live but no video plays, it's almost always one of: `FLEET_ENDPOINT`
not pointing at this fleet, the bearer mismatched between `TINYMOQ_PROVISION_KEY` and
`customers.json` `key` (→ 401 from `/assign`), or the `verify_jwk` / `kid` not matching
moqplay's signing key (→ the relay rejects the viewer token).

---

## Managed path (alternative)

If instead you use a **managed TinyMoQ CDN** (an operator running the fleet for you via
`tinymoq.com/cdnadmin`), they register the moqplay customer on their side and hand you the
**fleet endpoint** + **provisioning bearer** to paste into moqplay — i.e. you only do
steps **1–2** on the moqplay box and **skip the `customers.json` edit entirely**. You still
give them your **public** verify JWK (BYOK is unchanged); they install it.

## Reference

- [cloudflare-install.md](./cloudflare-install.md) — moqplay on Cloudflare (where these settings live; BYOK key-gen script)
- [ubuntu-install.md](./ubuntu-install.md) — moqplay on a single Ubuntu VM
- `src/worker/auth/moq-token.ts` — how moqplay mints the BYOK Ed25519 tokens (and the `kid`)
- [MEDIA-ENCRYPTION.md](./MEDIA-ENCRYPTION.md) — relay-blind E2E encryption
