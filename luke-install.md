# Standing up Luke Curley's `moq-relay` on Ubuntu (MoQplay Backend B)

MoQplay separates the **app** from the **relay**. This guide builds the **relay** — a
self-hosted [moq-dev/moq](https://github.com/moq-dev/moq/tree/main/rs/moq-relay) `moq-relay` on
a fresh Ubuntu VM with a real TLS cert, **open to anonymous clients**. That's MoQplay's
**Backend B** (see the "Choosing a CDN" section of [readme.md](./readme.md)): once it's running,
you point the app at it with two `wrangler.jsonc` vars — no code change.

It speaks Luke's native **moq-lite** (the home protocol of the `@moq` web components the app
already uses), so the browser negotiates `moq-lite-04` directly — no draft/fallback, no token.

> Verified path: this is the exact setup behind `https://luke.moqcdn.net`, used to validate
> Backend B end-to-end.

---

## 0. Prerequisites

- An **Ubuntu VM** with a **public IP** (tested on AWS EC2).
- A **domain/subdomain** whose DNS `A`/`AAAA` record points at that IP (e.g. `your.relay`).
- Inbound **port 443 open for BOTH TCP *and* UDP** — see [§4](#4-open-the-firewall--tcp-and-udp-443). This is the #1 gotcha; skip it and nothing plays.
- ~2 GB RAM for the Rust build.

---

## 1. System dependencies + Rust

```bash
sudo apt update
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # install Rust
. "$HOME/.cargo/env"
sudo apt install build-essential pkg-config libssl-dev nginx certbot python3-certbot-nginx npm ffmpeg
```

`build-essential`, `pkg-config`, `libssl-dev` are needed to build the relay. `certbot`
(+ plugin) is for the TLS cert (§3). `nginx`, `npm`, `ffmpeg` are **optional** — handy for
the cert HTTP challenge and for Luke's demo publisher/tooling, but the relay itself binds
:443 directly and does **not** need nginx fronting it.

---

## 2. Build the relay (and the token CLI)

```bash
git clone https://github.com/moq-dev/moq
cd moq
cargo build --release --bin moq-relay        # the relay
cargo build --release --bin moq-token-cli    # to generate the auth key (§5)
```

Binaries land in `moq/target/release/`. Building `main` gives you Luke's latest protocol
(currently moq-lite-04).

---

## 3. TLS certificate

The relay serves real WebTransport, so it needs a publicly-trusted cert. Free via Let's Encrypt:

```bash
sudo certbot certonly -d your.relay
```

Certs land in `/etc/letsencrypt/live/your.relay/{fullchain.pem,privkey.pem}`.
`certonly` uses port **80** for the HTTP-01 challenge — make sure :80 is free and reachable
during issuance (nothing else bound to it).

---

## 4. Open the firewall — TCP **and UDP** 443

**This is the step everyone misses.** WebTransport is HTTP/3 = **QUIC over UDP**. A normal
"HTTPS 443" rule is **TCP-only**, so the browser's QUIC packets never arrive: the player
fails with `connection error: AggregateError: All promises were rejected` and reconnect-loops
forever — even though `curl https://your.relay` (TCP/HTTP-2) works fine and the relay
log shows only scan noise.

- **AWS Security Group** → inbound → add **Custom UDP, port 443**, source `0.0.0.0/0` *and* a
  second rule for `::/0` (the relay binds `[::]`). Keep the existing TCP 443 rule too.
- **OS firewall** (if `ufw` is active):
  ```bash
  sudo ufw allow 443/tcp
  sudo ufw allow 443/udp
  ```

---

## 5. Generate the auth key (open / anonymous mode)

`moq-relay` always verifies tokens against a JWK, but you can grant **anonymous** access so
clients need no token — which is what the app's `static` `FLEET_MODE` expects (it sends no
`?jwt=`). Generate a key, then set `public = ""` in the config (§6):

```bash
./target/release/moq-token-cli generate --out ~/luke.jwk
```

`public = ""` makes **all paths** publicly publishable and subscribable (the empty prefix
matches everything). That's perfect for an open relay backend.

> **Want it locked down instead?** Omit `public` and issue per-client tokens:
> ```bash
> ./target/release/moq-token-cli sign --key ~/luke.jwk --root your.relay --publish "" --subscribe ""
> ```
> then have the app send `?jwt=<token>`. Note `static` mode sends **no** token, so for a
> token-gated relay you'd use the managed (token-minting) Backend C path instead — the same
> BYOK signing MoQplay uses for TinyMoQ.

---

## 6. `relay.toml`

```toml
[log]
level = "debug"                 # verbose; shows sessions, negotiated version, sub/pub

[server]
listen = "[::]:443"             # the MoQ endpoint: QUIC/WebTransport over UDP 443

[server.tls]
cert = ["/etc/letsencrypt/live/your.relay/fullchain.pem"]
key  = ["/etc/letsencrypt/live/your.relay/privkey.pem"]

# Optional: the relay's built-in web server (TCP 443). Safe to keep; the app doesn't need it.
# [server] (UDP/QUIC) and [web.https] (TCP) share port 443 without conflict — different transports.
[web.https]
listen = "[::]:443"
cert = "/etc/letsencrypt/live/your.relay/fullchain.pem"
key  = "/etc/letsencrypt/live/your.relay/privkey.pem"

[auth]
key = "/home/ubuntu/luke.jwk"   # from §5
public = ""                     # anonymous publish+subscribe on ALL paths (no token needed)
```

---

## 7. Run it

```bash
sudo ./target/release/moq-relay relay.toml
```

Binding :443 needs root (or grant the binary `CAP_NET_BIND_SERVICE`). `RUST_LOG=debug` gives
even more detail. For a long-lived relay, run it under **systemd** — minimal unit:

```ini
# /etc/systemd/system/moq-relay.service
[Unit]
Description=moq-relay
After=network-online.target

[Service]
ExecStart=/home/ubuntu/moq/target/release/moq-relay /home/ubuntu/relay.toml
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
User=ubuntu

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now moq-relay
journalctl -u moq-relay -f
```

---

## 8. Point the app at it

In your MoQplay deploy, set the fleet to this relay and deploy — no code change:

```jsonc
// wrangler.jsonc
"vars": {
  "FLEET_MODE": "static",
  "FLEET_ENDPOINT": "https://your.relay"
}
```
```bash
npm run deploy
```

`static` mode connects the browser straight to `FLEET_ENDPOINT` with no `/assign` and no
token — which works because of `public = ""`. To go back to the default Cloudflare relay (or
on to the managed TinyMoQ fleet), just swap these two vars — see the "Choosing a CDN" section
of [readme.md](./readme.md).

---

## Verify

Broadcast on the app, open the share link in a second browser. The relay log (`level=debug`)
should show a healthy session:

```
moq_relay::connection: session accepted transport="quic"
moq_relay::connection: negotiated version=moq-lite-04 transport="quic"
moq_net::lite::publisher:  subscribed started broadcast=moqplay.com/<id>.hang track=catalog.json
moq_net::lite::subscriber: subscribe started  broadcast=moqplay.com/<id>.hang track=video/hd
```

Browser console: `connected via WebTransport` and `negotiated ALPN: moq-lite-04`.

---

## Troubleshooting

- **Player loops with `AggregateError: All promises were rejected`, but `curl https://host` works** →
  UDP 443 is blocked. Fix the firewall ([§4](#4-open-the-firewall--tcp-and-udp-443)). This is by far the most common failure.
- **`WARN moq_native::tls: no SNI certificate found server_name=None` / `Illegal SNI ... IP address`** →
  internet scanners hitting the public IP; your browser sends `SNI=your.relay`. Ignore unless it lines up exactly with your own test.
- **Port 443 already in use** → don't also run nginx on 443; the relay binds it directly (TCP web + UDP QUIC).
- **Browser cert error** → `[server.tls]` must point at `fullchain.pem` + `privkey.pem`, and the cert's domain must match the host the app connects to (`FLEET_ENDPOINT`).
- **Connects but no media** → check the publisher and viewer used the *same* broadcast name (the relay log shows the `broadcast=` path for each); with `public=""` there's no auth to block it.

---

## Reference

- [moq-dev/moq `rs/moq-relay`](https://github.com/moq-dev/moq/tree/main/rs/moq-relay) — the relay
- [moq-relay auth docs](https://github.com/moq-dev/moq/blob/main/doc/bin/relay/auth.md) — keys, tokens, claims
- [readme.md → "Choosing a CDN"](./readme.md) — all three backends (config, not code)
- [MEDIA-ENCRYPTION.md](./MEDIA-ENCRYPTION.md) — relay-blind media encryption (rides above the transport, unaffected by which relay)
