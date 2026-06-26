// Frontend authentication utilities

export interface User {
  id: number;
  email: string;
  name: string;
  avatar_url: string;
}

export interface Geo {
  country: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string | null;
  continent: string | null;
}

export type Provider = "google";

export async function getCurrentUser(): Promise<{ user: User | null; geo: Geo | null }> {
  try {
    const response = await fetch("/api/auth/me");
    const data = await response.json();
    return { user: data.user, geo: data.geo };
  } catch {
    return { user: null, geo: null };
  }
}

// Convert ISO 3166-1 Alpha 2 country code to flag emoji
export function countryToFlag(countryCode: string | null): string {
  if (!countryCode || countryCode.length !== 2) return "";
  // Regional indicator symbols: A=🇦 (U+1F1E6), B=🇧 (U+1F1E7), etc.
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map((char) => 0x1f1e6 + char.charCodeAt(0) - 65);
  return String.fromCodePoint(...codePoints);
}

// Generic login - defaults to Google for backwards compatibility
export function login(): void {
  window.location.href = "/api/auth/google/login";
}

// Provider-specific login functions
export function loginWithGoogle(): void {
  window.location.href = "/api/auth/google/login";
}

export function logout(): void {
  window.location.href = "/api/auth/logout";
}

// Stats logging functions
export interface BroadcastStart {
  eventId: number;
  relay: string | null; // assigned tinymoq relay "host:port", or null on failure
  jwt: string | null; // per-broadcast publisher token (scoped to this stream), or null
  encrypted?: boolean; // true if this stream uses relay-blind E2E media encryption
  contentKey?: string | null; // per-broadcast AES content key (base64url) when encrypted
}

export async function logBroadcastStart(streamId: string, publisherCdn?: string): Promise<BroadcastStart | null> {
  try {
    console.log("Attempting to log broadcast start for stream:", streamId, publisherCdn ? `(publisher CDN: ${publisherCdn})` : "");
    const response = await fetch("/api/stats/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream_id: streamId, publisher_cdn: publisherCdn }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to log broadcast start:", response.status, errorText);
      return null;
    }
    const data = await response.json();
    console.log("Broadcast started with geo:", data.geo, "relay:", data.relay);
    return {
      eventId: data.id,
      relay: data.relay ?? null,
      jwt: data.jwt ?? null,
      encrypted: data.encrypted ?? false,
      contentKey: data.content_key ?? null,
    };
  } catch (e) {
    console.error("Error logging broadcast start:", e);
    return null;
  }
}

// Look up the relay hosting a live broadcast (for viewers to co-locate) plus a
// per-broadcast viewer token. Returns { relay: "host:port", jwt } or null if the
// stream is offline / not yet routed (404) or access is denied (401 on auth-required
// streams without a session). Optional viewerCdn pulls from a specific CDN destination;
// optional origin (publisher relay host:port) forces a cross-cluster pull source (testing).
export interface StreamRoute {
  relay: string;
  jwt: string | null;
  encrypted?: boolean; // true if this stream uses relay-blind E2E media encryption
  contentKey?: string | null; // per-broadcast AES content key (base64url); null if withheld (auth-gated)
  // Mode C (Enterprise): present only when the Worker resolved a PRIVATE on-net relay
  // for this viewer's network. The browser is the only thing that can reach `relay`.
  mode?: "enterprise";
  edgeHost?: string; // remote edge the local relay pulls the broadcast from
  broadcast?: string; // full broadcast name to subscribe to
  watchToken?: string; // browser -> local relay (mirrors jwt)
  pullToken?: string; // local relay -> edge (cluster-flagged pull pass)
}

export async function getStreamRoute(
  streamId: string,
  viewerCdn?: string,
  origin?: string,
  opts?: { noEnterprise?: boolean }
): Promise<StreamRoute | null> {
  try {
    const qp = new URLSearchParams();
    if (viewerCdn) qp.set("viewer-cdn", viewerCdn);
    if (origin) qp.set("origin", origin);
    // Tell the Worker to skip Mode C and return B/A (set after a failed enterprise attempt).
    if (opts?.noEnterprise) qp.set("noEnterprise", "1");
    const qs = qp.toString() ? `?${qp.toString()}` : "";
    const response = await fetch(`/api/streams/${streamId}/route${qs}`);
    if (!response.ok) return null; // 404 = offline, 401 = auth required
    const data = await response.json();
    if (!data.relay) return null;
    return {
      relay: data.relay,
      jwt: data.jwt ?? data.watchToken ?? null,
      encrypted: data.encrypted ?? false,
      contentKey: data.content_key ?? null,
      mode: data.mode === "enterprise" ? "enterprise" : undefined,
      edgeHost: data.edgeHost,
      broadcast: data.broadcast,
      watchToken: data.watchToken,
      pullToken: data.pullToken,
    };
  } catch {
    return null;
  }
}

export async function logBroadcastEnd(eventId: number): Promise<void> {
  try {
    await fetch(`/api/stats/broadcast/${eventId}/end`, { method: "POST" });
  } catch {
    // Ignore errors
  }
}

export async function logWatchStart(streamId: string): Promise<number | null> {
  try {
    const response = await fetch("/api/stats/watch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream_id: streamId }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.id;
  } catch {
    return null;
  }
}

export async function logWatchEnd(eventId: number): Promise<void> {
  try {
    await fetch(`/api/stats/watch/${eventId}/end`, { method: "POST" });
  } catch {
    // Ignore errors
  }
}

// Stream settings functions
export async function checkStreamExists(streamId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/streams/${streamId}/exists`);
    const data = await response.json();
    return data.exists ?? false;
  } catch {
    return false;
  }
}

export interface StreamSettings {
  require_auth: boolean;
  overlay_html: string;
  encrypted: boolean;
  chat_enabled: boolean;
}

export async function getStreamSettings(streamId: string): Promise<StreamSettings> {
  try {
    const response = await fetch(`/api/streams/${streamId}`);
    const data = await response.json();
    return {
      require_auth: data.require_auth ?? false,
      overlay_html: data.overlay_html ?? "",
      encrypted: data.encrypted ?? false,
      chat_enabled: data.chat_enabled ?? false,
    };
  } catch {
    return { require_auth: false, overlay_html: "", encrypted: false, chat_enabled: false };
  }
}

export async function updateStreamSettings(
  streamId: string,
  settings: Partial<Omit<StreamSettings, never>>
): Promise<void> {
  try {
    await fetch("/api/streams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream_id: streamId, ...settings }),
    });
  } catch {
    // Ignore errors
  }
}

// Live stats
export interface LiveBroadcast {
  id: number;
  stream_id: string;
  started_at: string;
  user_id: number;
  user_name: string;
  user_email: string;
  avatar_url: string;
  geo_country: string | null;
  geo_city: string | null;
  geo_region: string | null;
  geo_latitude: string | null;
  geo_longitude: string | null;
  geo_timezone: string | null;
}

export interface LiveViewer {
  id: number;
  stream_id: string;
  started_at: string;
  user_id: number | null;
  user_name: string | null;
  user_email: string | null;
  avatar_url: string | null;
  geo_country: string | null;
  geo_city: string | null;
  geo_region: string | null;
  geo_latitude: string | null;
  geo_longitude: string | null;
  geo_timezone: string | null;
}

export async function getLiveStats(): Promise<{ broadcasts: LiveBroadcast[]; viewers: LiveViewer[] } | null> {
  try {
    const response = await fetch("/api/stats/live");
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function getStreamViewers(streamId: string): Promise<{ stream_id: string; viewers: LiveViewer[] } | null> {
  try {
    const response = await fetch(`/api/stats/stream/${streamId}/viewers`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
