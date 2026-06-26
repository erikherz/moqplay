// Per-broadcast MoQ relay tokens. Short-lived, scope-limited JWTs minted by the Worker
// and passed to the TinyMoQ relay as the `?jwt=` query param on the WebTransport URL.
// The relay verifies the signature, then enforces the `put`/`get` scopes + `exp`.
//
// TWO signing modes, selected by configuration (so this file is tenant-agnostic):
//
//   BYOK (asymmetric):  EdDSA (Ed25519) with the tenant's OWN private key
//                       (MOQ_AUTH_PRIVATE_JWK). Only the matching PUBLIC key is
//                       registered with TinyMoQ — the relay never holds a signing key.
//
//   Managed (symmetric): HS256 with a per-stream HMAC secret that /assign returns
//                       (`key` field). TinyMoQ keys the relay per broadcast; a
//                       reap/respawn rotates the key (old tokens die = revocation).
//                       Do NOT cache it — sign on demand with what /assign returned.
//
// Same claim contract either way (PER-BROADCAST-TOKENS.md): unpadded base64url
// everywhere, `exp` in unix SECONDS. Signing input is base64url(header) + "." +
// base64url(payload); the token is that + "." + base64url(signature).

// Earthseed's Ed25519 key id (RFC 7638 JWK thumbprint) — fallback if the private JWK
// secret omits its own `kid`. The relay selects the verifying key by this kid.
export const MOQ_KID = "X3KzNJpRvVarbKBM2mk_M5JGt0dDYu85ZA5z2nLb1Qk";
// Managed HS256 mode: the relay has the per-stream key and ignores `kid`; keep it
// constant so tokens stay identical to the moq-token-cli tooling.
const HS256_KID = "9309ffde64e0bf0f";

const ED25519 = { name: "Ed25519" } as const;

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = new Uint8Array(buf as ArrayBuffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecodeToBytes = (s: string): Uint8Array => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export interface MoqClaims {
  put: string[]; // path prefixes the holder may publish to ([] = none)
  get: string[]; // path prefixes the holder may subscribe to
  exp: number; // expiry, unix SECONDS
  // Cross-cluster pull flag. Set only on the `&pull=` token handed to a viewer-CDN edge
  // relay so it may pull this broadcast from the publisher's origin relay across clusters.
  // Omitted (undefined) on ordinary publisher/viewer tokens, so they are byte-identical
  // to before — JSON.stringify drops undefined fields.
  cluster?: boolean;
}

const sign = async (header: object, claims: MoqClaims, signFn: (input: Uint8Array) => Promise<ArrayBuffer>): Promise<string> => {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${enc(header)}.${enc(claims)}`;
  const sig = await signFn(new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
};

// BYOK: sign with the tenant's Ed25519 private key. `privateJwk` is an OKP JWK (JSON
// string with `d`), e.g. env.MOQ_AUTH_PRIVATE_JWK.
export async function mintEd25519Token(privateJwk: string, claims: MoqClaims): Promise<string> {
  const jwk = JSON.parse(privateJwk) as JsonWebKey & { kid?: string };
  const key = await crypto.subtle.importKey("jwk", jwk, ED25519, false, ["sign"]);
  const header = { typ: "JWT", alg: "EdDSA", kid: jwk.kid ?? MOQ_KID };
  return sign(header, claims, (input) => crypto.subtle.sign(ED25519, key, input));
}

// Managed: sign with a per-stream HMAC secret (base64url "k") returned by /assign.
export async function mintHs256Token(secretK: string, claims: MoqClaims): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    b64urlDecodeToBytes(secretK),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const header = { typ: "JWT", alg: "HS256", kid: HS256_KID };
  return sign(header, claims, (input) => crypto.subtle.sign("HMAC", key, input));
}
