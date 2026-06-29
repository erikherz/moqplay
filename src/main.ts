// Safari WebSocket fallback - MUST install before hang components load
// Using our patched version that handles requireUnreliable gracefully
import { install as installWebTransportPolyfill } from "./webtransport-polyfill";
// WebCodecs polyfill for Opus audio encoding on Safari
import { install as installWebCodecsPolyfill } from "./webcodecs-polyfill";

// Detect Safari - even Safari 17+ with WebTransport has compatibility issues with some relays
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

// Check if we need the polyfill: only when WebTransport is not available
// Safari now uses native WebTransport with Cloudflare relay (fallback relays disabled)
const needsPolyfill = typeof WebTransport === "undefined";
if (needsPolyfill) {
  const reason = typeof WebTransport === "undefined"
    ? "WebTransport not supported"
    : "Safari detected (using WebSocket for better compatibility)";
  console.log(`${reason}, installing WebSocket polyfill`);
  // Install polyfill - use force=true for Safari since it has native WebTransport
  // but with compatibility issues that require using WebSocket instead
  installWebTransportPolyfill(isSafari);
}

// Safari audio track fix - Safari doesn't return channelCount in getSettings()
// which causes the hang library to fail with "expected number" error
if (isSafari) {
  const originalGetSettings = MediaStreamTrack.prototype.getSettings;
  MediaStreamTrack.prototype.getSettings = function () {
    const settings = originalGetSettings.call(this);
    // Add default channelCount for audio tracks if missing
    if (this.kind === "audio" && settings.channelCount === undefined) {
      settings.channelCount = 1; // Mono default, Safari typically captures mono
    }
    return settings;
  };
  console.log("Safari: Patched MediaStreamTrack.getSettings for channelCount");
}

// Theme initialization - must run early to prevent flash
function initTheme() {
  const savedTheme = localStorage.getItem("theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

  if (savedTheme === "light" || (!savedTheme && !prefersDark)) {
    document.documentElement.classList.add("light");
  }

  document.addEventListener("DOMContentLoaded", () => {
    const themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
      themeToggle.addEventListener("click", () => {
        document.documentElement.classList.toggle("light");
        const isLight = document.documentElement.classList.contains("light");
        localStorage.setItem("theme", isLight ? "light" : "dark");
      });
    }
  });
}
initTheme();

// --- Minimal typings for the headless @moq/publish + @moq/watch core elements ---
// The core elements render no controls of their own; we drive them programmatically.
// @moq/signals Signals expose peek()/set()/subscribe() (subscribe returns an unsubscribe fn).
interface MoqSignal<T> {
  peek(): T;
  set(value: T): void;
  subscribe(fn: (value: T) => void): () => void;
}
type ConnStatus = "disconnected" | "connecting" | "connected";
type PublishSource = "camera" | "screen" | "file" | null | undefined;

interface MoqPublishElement extends HTMLElement {
  source: PublishSource;
  invisible: boolean;
  muted: boolean;
  connection: { status: MoqSignal<ConnStatus> };
  state: { source: MoqSignal<PublishSource> };
}

interface MoqWatchElement extends HTMLElement {
  muted: boolean;
}

// Safari fallback relay servers (WebSocket-enabled)
// Pinned to the single test box for the full end-to-end test (no prod traffic).
const FALLBACK_RELAYS = [
  "cdn.gpcmoq.com",
];

// Server status tracking
interface RelayResult {
  domain: string;
  latency: number | null; // null if failed
  error?: string;
}

interface ServerStatus {
  mode: "websocket" | "webtransport";
  selectedServer: string;
  connected: boolean;
  raceResults: RelayResult[];
}

const serverStatus: ServerStatus = {
  mode: needsPolyfill ? "websocket" : "webtransport",
  selectedServer: "cdn.gpcmoq.com",
  connected: false,
  raceResults: [],
};

// Browser support tracking
interface CodecSupport {
  software: boolean;
  hardware?: boolean; // undefined means unknown (Firefox)
}

interface BrowserSupport {
  browser: string;
  isFirefox: boolean;
  isSafari: boolean;
  supported: boolean;
  features: {
    webTransport: boolean;
    mediaDevices: boolean;
    audio: {
      capture: boolean;
      render: boolean;
      encoding?: { aac: boolean; opus: boolean };
      decoding?: { aac: boolean; opus: boolean };
    };
    video: {
      capture: "full" | "partial" | "none";
      render: boolean;
      encoding?: { h264: CodecSupport; h265: CodecSupport; vp8: CodecSupport; vp9: CodecSupport; av1: CodecSupport };
      decoding?: { h264: CodecSupport; h265: CodecSupport; vp8: CodecSupport; vp9: CodecSupport; av1: CodecSupport };
    };
  };
}

const CODECS: Record<string, string> = {
  aac: "mp4a.40.2",
  opus: "opus",
  av1: "av01.0.08M.08",
  h264: "avc1.640028",
  h265: "hev1.1.6.L93.B0",
  vp9: "vp09.00.10.08",
  vp8: "vp8",
};

async function checkAudioEncoder(codec: string): Promise<boolean> {
  try {
    const res = await AudioEncoder.isConfigSupported({
      codec: CODECS[codec],
      numberOfChannels: 2,
      sampleRate: 48000,
    });
    return res.supported === true;
  } catch { return false; }
}

async function checkAudioDecoder(codec: string): Promise<boolean> {
  try {
    const res = await AudioDecoder.isConfigSupported({
      codec: CODECS[codec],
      numberOfChannels: 2,
      sampleRate: 48000,
    });
    return res.supported === true;
  } catch { return false; }
}

async function checkVideoEncoder(codec: string, isFirefox: boolean): Promise<CodecSupport> {
  try {
    const software = await VideoEncoder.isConfigSupported({
      codec: CODECS[codec],
      width: 1280,
      height: 720,
      hardwareAcceleration: "prefer-software",
    });
    const hardware = await VideoEncoder.isConfigSupported({
      codec: CODECS[codec],
      width: 1280,
      height: 720,
      hardwareAcceleration: "prefer-hardware",
    });
    const unknownHw = isFirefox || hardware.config?.hardwareAcceleration !== "prefer-hardware";
    return {
      software: software.supported === true,
      hardware: unknownHw ? undefined : hardware.supported === true,
    };
  } catch { return { software: false }; }
}

async function checkVideoDecoder(codec: string, isFirefox: boolean): Promise<CodecSupport> {
  try {
    const software = await VideoDecoder.isConfigSupported({
      codec: CODECS[codec],
      hardwareAcceleration: "prefer-software",
    });
    const hardware = await VideoDecoder.isConfigSupported({
      codec: CODECS[codec],
      hardwareAcceleration: "prefer-hardware",
    });
    const unknownHw = isFirefox || hardware.config?.hardwareAcceleration !== "prefer-hardware";
    return {
      software: software.supported === true,
      hardware: unknownHw ? undefined : hardware.supported === true,
    };
  } catch { return { software: false }; }
}

async function detectBrowserSupport(): Promise<BrowserSupport> {
  // Detect browser - use consistent detection with global isSafari
  const ua = navigator.userAgent;
  let browser = "Unknown";
  const isFirefox = /firefox/i.test(ua);
  if (isFirefox) {
    browser = "Firefox";
  } else if (/edg/i.test(ua)) {
    browser = "Edge";
  } else if (/chrome/i.test(ua)) {
    browser = "Chrome";
  } else if (isSafari) {
    // Use global isSafari which has proper negative lookahead for Chrome/Android
    browser = "Safari";
  }

  const webTransport = typeof WebTransport !== "undefined";
  const mediaDevices = typeof navigator.mediaDevices?.getUserMedia === "function";

  // Audio features
  const audioCapture = typeof AudioWorkletNode !== "undefined";
  const audioRender = typeof AudioContext !== "undefined" && typeof AudioBufferSourceNode !== "undefined";

  let audioEncoding: { aac: boolean; opus: boolean } | undefined;
  let audioDecoding: { aac: boolean; opus: boolean } | undefined;

  if (typeof AudioEncoder !== "undefined") {
    audioEncoding = {
      aac: await checkAudioEncoder("aac"),
      opus: await checkAudioEncoder("opus"),
    };
  }
  if (typeof AudioDecoder !== "undefined") {
    audioDecoding = {
      aac: await checkAudioDecoder("aac"),
      opus: await checkAudioDecoder("opus"),
    };
  }

  // Video features
  // @ts-expect-error MediaStreamTrackProcessor not in all TS libs
  const hasMediaStreamTrackProcessor = typeof MediaStreamTrackProcessor !== "undefined";
  const hasOffscreenCanvas = typeof OffscreenCanvas !== "undefined";
  const videoCapture: "full" | "partial" | "none" = hasMediaStreamTrackProcessor
    ? "full"
    : hasOffscreenCanvas
      ? "partial"
      : "none";
  const videoRender = hasOffscreenCanvas && typeof CanvasRenderingContext2D !== "undefined";

  let videoEncoding: BrowserSupport["features"]["video"]["encoding"];
  let videoDecoding: BrowserSupport["features"]["video"]["decoding"];

  if (typeof VideoEncoder !== "undefined") {
    videoEncoding = {
      h264: await checkVideoEncoder("h264", isFirefox),
      h265: await checkVideoEncoder("h265", isFirefox),
      vp8: await checkVideoEncoder("vp8", isFirefox),
      vp9: await checkVideoEncoder("vp9", isFirefox),
      av1: await checkVideoEncoder("av1", isFirefox),
    };
  }
  if (typeof VideoDecoder !== "undefined") {
    videoDecoding = {
      h264: await checkVideoDecoder("h264", isFirefox),
      h265: await checkVideoDecoder("h265", isFirefox),
      vp8: await checkVideoDecoder("vp8", isFirefox),
      vp9: await checkVideoDecoder("vp9", isFirefox),
      av1: await checkVideoDecoder("av1", isFirefox),
    };
  }

  // Supported if we have WebTransport OR Safari (which uses WebSocket fallback)
  const supported = webTransport || isSafari;

  return {
    browser,
    isFirefox,
    isSafari,
    supported,
    features: {
      webTransport,
      mediaDevices,
      audio: {
        capture: audioCapture,
        render: audioRender,
        encoding: audioEncoding,
        decoding: audioDecoding,
      },
      video: {
        capture: videoCapture,
        render: videoRender,
        encoding: videoEncoding,
        decoding: videoDecoding,
      },
    },
  };
}

let browserSupport: BrowserSupport;

// Update the browser support panel UI
function updateBrowserSupportPanel() {
  const supportPanel = document.getElementById("support-panel");
  if (!supportPanel || !browserSupport) return;

  // Determine overall status - "Partial" if using polyfill, "Full" if native WebTransport
  const isPartial = needsPolyfill;
  const statusClass = browserSupport.supported ? (isPartial ? "partial" : "connected") : "disconnected";
  const statusText = browserSupport.supported ? (isPartial ? "Partial Support" : "Full Support") : "Not Supported";

  // Build details HTML
  const green = '<span class="status-dot green"></span>';
  const red = '<span class="status-dot red"></span>';
  const yellow = '<span class="status-dot yellow"></span>';

  const bool = (v: boolean) => v ? `${green} Yes` : `${red} No`;

  // WebTransport status - show "Polyfill" if we're using the fallback
  const webTransportStatus = () => {
    if (needsPolyfill) {
      return `${yellow} Polyfill`;
    }
    return browserSupport.features.webTransport ? `${green} Full` : `${red} No`;
  };

  const captureStatus = (v: "full" | "partial" | "none") => {
    if (v === "full") return `${green} Full`;
    if (v === "partial") return `${yellow} Partial`;
    return `${red} No`;
  };

  const codecStatus = (c: CodecSupport | undefined, isFirefox: boolean) => {
    if (!c || (!c.software && !c.hardware)) return `${red} No`;
    if (c.hardware === true) return `${green} Hardware`;
    if (c.hardware === undefined && isFirefox) return `${yellow} Software*`;
    if (c.software) return `${yellow} Software`;
    return `${red} No`;
  };

  const audioCodecStatus = (supported: boolean | undefined) => {
    if (supported === undefined) return `${red} No`;
    return supported ? `${green} Yes` : `${red} No`;
  };

  const f = browserSupport.features;
  const isFirefox = browserSupport.isFirefox;

  // Note for polyfill or Firefox
  let footerNote = "";
  if (needsPolyfill) {
    footerNote = `<p class="support-note">Using WebSocket polyfill for Safari compatibility.</p>`;
  }
  if (isFirefox) {
    footerNote += `<p class="support-note">*Hardware acceleration is <a href="https://github.com/nickeltin/browser-support" target="_blank">undetectable</a> on Firefox.</p>`;
  }

  const detailsContent = `
    <table class="latency-results">
      <tbody>
        <tr><td><strong>WebTransport</strong></td><td>${webTransportStatus()}</td></tr>
        <tr><td><strong>Rendering</strong></td><td>Audio</td><td>${bool(f.audio.render)}</td></tr>
        <tr><td></td><td>Video</td><td>${bool(f.video.render)}</td></tr>
        <tr><td><strong>Decoding</strong></td><td>Opus</td><td>${f.audio.decoding ? audioCodecStatus(f.audio.decoding.opus) : `${red} No`}</td></tr>
        <tr><td></td><td>AAC</td><td>${f.audio.decoding ? audioCodecStatus(f.audio.decoding.aac) : `${red} No`}</td></tr>
        <tr><td></td><td>AV1</td><td>${f.video.decoding ? codecStatus(f.video.decoding.av1, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>H.265</td><td>${f.video.decoding ? codecStatus(f.video.decoding.h265, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>H.264</td><td>${f.video.decoding ? codecStatus(f.video.decoding.h264, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>VP9</td><td>${f.video.decoding ? codecStatus(f.video.decoding.vp9, isFirefox) : `${red} No`}</td></tr>
        <tr><td></td><td>VP8</td><td>${f.video.decoding ? codecStatus(f.video.decoding.vp8, isFirefox) : `${red} No`}</td></tr>
      </tbody>
    </table>
    ${footerNote}
  `;

  supportPanel.innerHTML = `
    <div class="server-status-summary">
      <span class="status-indicator ${statusClass}"></span>
      <span>${statusText}: ${browserSupport.browser}</span>
      <button class="details-btn" id="support-details-btn">Details</button>
    </div>
    <div class="server-details hidden" id="support-details-content">
      ${detailsContent}
    </div>
  `;

  // Add details toggle handler
  document.getElementById("support-details-btn")?.addEventListener("click", () => {
    const details = document.getElementById("support-details-content");
    const btn = document.getElementById("support-details-btn");
    if (details && btn) {
      const isHidden = details.classList.contains("hidden");
      details.classList.toggle("hidden");
      btn.textContent = isHidden ? "Hide" : "Details";
    }
  });
}

// Race requests to find the lowest-latency relay server
async function selectBestFallbackRelay(): Promise<string> {
  const testPath = "/fingerprint";
  const timeout = 5000; // 5 second timeout per server

  // Track all results for the status panel
  const results: RelayResult[] = FALLBACK_RELAYS.map(domain => ({
    domain,
    latency: null,
  }));

  // Create a promise for each server that resolves with result
  const racePromises = FALLBACK_RELAYS.map(async (domain, index) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const startTime = performance.now();

    try {
      const response = await fetch(`https://${domain}:8888${testPath}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const latency = performance.now() - startTime;
        results[index].latency = latency;
        console.log(`Relay ${domain} responded in ${latency.toFixed(0)}ms`);
        return { domain, latency };
      }
      const error = `HTTP ${response.status}`;
      results[index].error = error;
      throw new Error(error);
    } catch (error) {
      clearTimeout(timeoutId);
      if (!results[index].error) {
        results[index].error = error instanceof Error ? error.message : "Failed";
      }
      console.warn(`Relay ${domain} failed:`, error);
      throw error;
    }
  });

  // Wait a bit for all results to come in (for display purposes)
  // but use Promise.any to select the winner quickly
  const winnerPromise = Promise.any(racePromises);

  // Also wait for all to settle (with a shorter timeout for UI)
  const allSettledPromise = Promise.allSettled(racePromises);

  try {
    const winner = await winnerPromise;
    console.log(`Selected relay: ${winner.domain} (${winner.latency.toFixed(0)}ms)`);

    // Wait briefly for other results to populate (for status panel)
    await Promise.race([
      allSettledPromise,
      new Promise(resolve => setTimeout(resolve, 1000)),
    ]);

    serverStatus.raceResults = results;
    serverStatus.selectedServer = winner.domain;
    serverStatus.connected = true;

    return winner.domain;
  } catch {
    console.warn("All relay servers failed latency test, using default");
    serverStatus.raceResults = results;
    serverStatus.selectedServer = FALLBACK_RELAYS[0];
    serverStatus.connected = false;
    return FALLBACK_RELAYS[0];
  }
}

// Update the server status panel UI
function updateServerStatusPanel() {
  const serverPanel = document.getElementById("server-panel");
  if (!serverPanel) return;

  const statusClass = serverStatus.connected ? "connected" : "disconnected";
  const statusText = serverStatus.connected ? "Connected" : "Disconnected";
  const modeLabel = serverStatus.mode === "websocket" ? "WebSocket (Safari fallback)" : "WebTransport (native)";

  // Build details HTML
  let detailsContent = `
    <p><strong>Mode:</strong> ${modeLabel}</p>
    <p><strong>Server:</strong> ${serverStatus.selectedServer}</p>
  `;

  if (serverStatus.mode === "websocket" && serverStatus.raceResults.length > 0) {
    detailsContent += `
      <p><strong>Latency Test Results:</strong></p>
      <table class="latency-results">
        <thead><tr><th>Server</th><th>Latency</th></tr></thead>
        <tbody>
    `;

    // Sort by latency (successful first, then failed)
    const sorted = [...serverStatus.raceResults].sort((a, b) => {
      if (a.latency === null && b.latency === null) return 0;
      if (a.latency === null) return 1;
      if (b.latency === null) return -1;
      return a.latency - b.latency;
    });

    for (const result of sorted) {
      const isSelected = result.domain === serverStatus.selectedServer;
      const latencyText = result.latency !== null
        ? `${result.latency.toFixed(0)}ms`
        : `Failed: ${result.error || "timeout"}`;
      const rowClass = isSelected ? "selected" : (result.latency === null ? "failed" : "");
      detailsContent += `<tr class="${rowClass}"><td>${result.domain}</td><td>${latencyText}</td></tr>`;
    }

    detailsContent += `</tbody></table>`;
  }

  serverPanel.innerHTML = `
    <div class="server-status-summary">
      <span class="status-indicator ${statusClass}"></span>
      <span>${statusText}: ${serverStatus.selectedServer}</span>
      <button class="details-btn" id="server-details-btn">Details</button>
    </div>
    <div class="server-details hidden" id="server-details-content">
      ${detailsContent}
    </div>
  `;

  // Add details toggle handler
  document.getElementById("server-details-btn")?.addEventListener("click", () => {
    const details = document.getElementById("server-details-content");
    const btn = document.getElementById("server-details-btn");
    if (details && btn) {
      const isHidden = details.classList.contains("hidden");
      details.classList.toggle("hidden");
      btn.textContent = isHidden ? "Hide" : "Details";
    }
  });
}

// Record the relay this client actually connected to (assigned/routed, possibly a
// CDN override or cross-cluster edge) and refresh the footer Server Status panel.
function setActiveRelay(relay: string | null) {
  serverStatus.selectedServer = relay ?? "(no relay assigned)";
  serverStatus.connected = !!relay;
  updateServerStatusPanel();
}

// Status pills shown in the publisher header and on the player. We make a claim at each
// layer and nothing more: "Relay-blind" is an INFRASTRUCTURE property (encryption is
// mandatory, so it shows on every stream and says nothing about who may watch); the
// audience pill carries the ACCESS claim (Public vs Invite-only); and "Security details"
// hangs the honest caveats (static key, metadata, not-DRM) off the access affordance.
const SHIELD_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>`;
const GLOBE_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
const LOCK_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const PILL_CSS =
  "display:inline-flex;align-items:center;gap:4px;font-size:0.72rem;font-weight:600;" +
  "border:1px solid;border-radius:999px;padding:2px 8px;line-height:1;white-space:nowrap;";

// "Relay-blind" — shown on EVERY stream (encryption is mandatory). States that the relay
// and server only ever move ciphertext they can't read. Deliberately NOT a privacy claim
// about who may watch — that is the audience pill's job.
function createRelayBlindBadge(): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "relay-blind-badge";
  badge.title = "Encrypted in your browser, decrypted in viewers' browsers. The relay and server only move ciphertext they can't read.";
  badge.innerHTML = SHIELD_SVG + `<span>Relay-blind</span>`;
  badge.style.cssText = PILL_CSS + "color:#22c55e;border-color:rgba(34,197,94,0.5);";
  return badge;
}

// Audience pill — carries the ACCESS claim, driven by require_auth. Public = anyone with
// the link; Invite-only = viewers must sign in to receive the key. Mutated in place so a
// single element can track the live toggle.
function setAudienceBadge(badge: HTMLSpanElement, inviteOnly: boolean): void {
  const color = inviteOnly ? "#f59e0b" : "#9ca3af";
  badge.title = inviteOnly
    ? "Invite-only — viewers must sign in to receive the key and watch."
    : "Public — anyone with the link can watch.";
  badge.innerHTML = (inviteOnly ? LOCK_SVG : GLOBE_SVG) + `<span>${inviteOnly ? "Invite-only" : "Public"}</span>`;
  badge.style.color = color;
  badge.style.borderColor = color;
}

function createAudienceBadge(inviteOnly: boolean): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "audience-badge";
  badge.style.cssText = PILL_CSS;
  setAudienceBadge(badge, inviteOnly);
  return badge;
}

// "Security details" disclosure — the honest caveats that attach to the access claim,
// surfaced at the moment a user reasons about privacy. Click toggles a small popover;
// an outside click closes it.
function createSecurityDetails(): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.className = "security-details";
  wrap.style.cssText = "position:relative;display:inline-flex;align-items:center;";
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = "Security details";
  link.style.cssText = "font-size:0.72rem;color:#9ca3af;text-decoration:underline;cursor:pointer;white-space:nowrap;";
  const pop = document.createElement("div");
  pop.style.cssText =
    "display:none;position:absolute;z-index:60;top:calc(100% + 6px);left:0;width:290px;" +
    "background:#1a1a1a;border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:10px 12px;" +
    "font-size:0.72rem;line-height:1.45;color:#d1d5db;box-shadow:0 8px 28px rgba(0,0,0,0.55);text-align:left;";
  pop.innerHTML =
    `<strong style="color:#f3f4f6;display:block;margin-bottom:6px;">What encryption does and doesn't cover</strong>` +
    `<ul style="margin:0;padding-left:16px;display:flex;flex-direction:column;gap:6px;">` +
    `<li><strong>No live revocation.</strong> The per-session key is static — a viewer removed mid-stream who kept the key can keep decrypting until this broadcast ends (the next session uses a fresh key).</li>` +
    `<li><strong>Metadata in the clear.</strong> Codec, resolution, frame timing and sizes, and track names are visible to the relay.</li>` +
    `<li><strong>Not DRM.</strong> Anyone allowed to watch can screen-capture the decoded video.</li>` +
    `</ul>`;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    pop.style.display = pop.style.display === "none" ? "block" : "none";
  });
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target as Node)) pop.style.display = "none";
  });
  wrap.append(link, pop);
  return wrap;
}

// Per-broadcast relay tokens are minted server-side (BYOK) and returned by the Worker:
// publishers get one from POST /api/stats/broadcast, viewers from GET /route. There is no
// static client token — the browser never holds a long-lived, all-paths credential.
const NAMESPACE_PREFIX = "moqplay.com";

// Dynamic imports for the MoQ web components - MUST happen after polyfills are installed.
// These register the headless light-DOM core elements <moq-publish> and <moq-watch>
// from @moq/publish + @moq/watch (which use @moq/net, negotiating moq-lite-04).
// ES module static imports are hoisted and execute before any code runs.
const loadHangComponents = async () => {
  // Install WebCodecs polyfill for Opus audio encoding (Safari)
  // This must complete before the components try to use AudioEncoder
  await installWebCodecsPolyfill();

  await import("@moq/publish/element");
  await import("@moq/watch/element");
};

import {
  getCurrentUser,
  countryToFlag,
  loginWithGoogle,
  logout,
  logBroadcastStart,
  logBroadcastEnd,
  logWatchStart,
  logWatchEnd,
  getStreamRoute,
  checkStreamExists,
  getStreamSettings,
  updateStreamSettings,
  getLiveStats,
  getStreamViewers,
  type User,
  type Geo,
  type StreamSettings,
  type LiveBroadcast,
  type LiveViewer,
  type StreamRoute
} from "./auth";
import { armPublisher, armViewer, setMediaKey, resetMediaKey } from "./crypto/media-crypto";
import { initChat, type ChatHandle } from "./chat/chat-client";
import { createCompositor, type Compositor } from "./media/pip-compositor";

type View = "broadcast" | "watch" | "stats" | "stats-map" | "greet" | "stream-stats" | "stream-stats-map" | "admin";

// Generate a random stream ID (5 lowercase alphanumeric characters)
function generateRandomId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Generate a unique stream ID, checking for collisions
async function generateStreamId(): Promise<string> {
  const maxAttempts = 10;
  for (let i = 0; i < maxAttempts; i++) {
    const id = generateRandomId();
    const exists = await checkStreamExists(id);
    if (!exists) {
      return id;
    }
    console.log(`Stream ID ${id} already in use, generating new one...`);
  }
  // Fallback: return a random ID even if we couldn't verify uniqueness
  return generateRandomId();
}

// Check if a string is a valid stream ID (5 lowercase alphanumeric)
function isValidStreamId(str: string): boolean {
  return /^[a-z0-9]{5}$/.test(str);
}

// Determine current view and stream ID from URL
async function getRouteInfo(): Promise<{ view: View; streamId: string }> {
  const path = window.location.pathname;

  // Stats map view: /stats/map
  if (path === "/stats/map") {
    return { view: "stats-map", streamId: "" };
  }

  // Greet view: /greet (broadcasters map)
  if (path === "/greet") {
    return { view: "greet", streamId: "" };
  }

  // Admin view: /cleardata
  if (path === "/cleardata") {
    return { view: "admin", streamId: "" };
  }

  // Stats view: /stats
  if (path === "/stats") {
    return { view: "stats", streamId: "" };
  }

  // Stream-specific stats map view: /{streamId}/stats/map
  const streamStatsMapMatch = path.match(/^\/([a-z0-9]{5})\/stats\/map$/);
  if (streamStatsMapMatch) {
    return { view: "stream-stats-map", streamId: streamStatsMapMatch[1] };
  }

  // Stream-specific stats view: /{streamId}/stats
  const streamStatsMatch = path.match(/^\/([a-z0-9]{5})\/stats$/);
  if (streamStatsMatch) {
    return { view: "stream-stats", streamId: streamStatsMatch[1] };
  }

  // Watch view: /{streamId} (5 char alphanumeric)
  const potentialStreamId = path.slice(1); // Remove leading /
  if (isValidStreamId(potentialStreamId)) {
    return { view: "watch", streamId: potentialStreamId };
  }

  // Broadcast view: / or /?stream=xxx
  const params = new URLSearchParams(window.location.search);
  let streamId = params.get("stream");

  if (!streamId) {
    streamId = await generateStreamId();
    // Update URL without reload
    const newUrl = `${window.location.pathname}?stream=${streamId}`;
    window.history.replaceState({}, "", newUrl);
  }

  return { view: "broadcast", streamId };
}

// Update the auth UI based on login state
function updateAuthUI(user: User | null, geo: Geo | null) {
  const authContainer = document.getElementById("auth-container");
  const newStreamBtn = document.getElementById("new-stream-btn");

  // Hide header buttons when not logged in (login overlay will show instead)
  if (!user) {
    if (authContainer) authContainer.innerHTML = "";
    if (newStreamBtn) newStreamBtn.classList.add("hidden");
    return;
  }

  // Show New Stream button for logged in users
  if (newStreamBtn) newStreamBtn.classList.remove("hidden");

  if (!authContainer) return;

  // Show logged-in user info
  const avatarHtml = user.avatar_url
    ? `<img src="${user.avatar_url}" alt="${user.name}" class="avatar">`
    : `<div class="avatar avatar-placeholder">${user.name.charAt(0).toUpperCase()}</div>`;

  const flag = countryToFlag(geo?.country ?? null);
  const hasCoords = geo?.latitude && geo?.longitude;

  // Build location tooltip content
  const locationParts: string[] = [];
  if (geo?.city) locationParts.push(geo.city);
  if (geo?.region) locationParts.push(geo.region);
  if (geo?.postalCode) locationParts.push(geo.postalCode);
  if (geo?.country) locationParts.push(geo.country);

  let flagHtml = "";
  if (flag) {
    const clickable = hasCoords ? "clickable" : "";
    flagHtml = `<span class="user-flag ${clickable}" id="user-flag">${flag}</span>`;
  }

  authContainer.innerHTML = `
    <div class="user-info">
      ${avatarHtml}
      <span class="user-name">${user.name}</span>${flagHtml}
      <button id="logout-btn" class="btn btn-icon" title="Sign Out">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
      </button>
    </div>
    ${flag ? `<div class="geo-tooltip" id="geo-tooltip">
      <div class="geo-tooltip-content">
        ${geo?.city ? `<div class="geo-row"><span class="geo-label">City</span><span class="geo-value">${geo.city}</span></div>` : ""}
        ${geo?.region ? `<div class="geo-row"><span class="geo-label">Region</span><span class="geo-value">${geo.region}</span></div>` : ""}
        ${geo?.postalCode ? `<div class="geo-row"><span class="geo-label">Postal</span><span class="geo-value">${geo.postalCode}</span></div>` : ""}
        ${geo?.country ? `<div class="geo-row"><span class="geo-label">Country</span><span class="geo-value">${geo.country}</span></div>` : ""}
        ${geo?.continent ? `<div class="geo-row"><span class="geo-label">Continent</span><span class="geo-value">${geo.continent}</span></div>` : ""}
        ${geo?.timezone ? `<div class="geo-row"><span class="geo-label">Timezone</span><span class="geo-value">${geo.timezone}</span></div>` : ""}
        ${hasCoords ? `<div class="geo-row"><span class="geo-label">Coords</span><span class="geo-value">${geo.latitude}, ${geo.longitude}</span></div>` : ""}
        ${hasCoords ? `<div class="geo-action">Click flag to open in Google Maps</div>` : ""}
      </div>
    </div>` : ""}
  `;

  document.getElementById("logout-btn")?.addEventListener("click", logout);

  // Flag hover and click handlers
  const flagEl = document.getElementById("user-flag");
  const tooltipEl = document.getElementById("geo-tooltip");

  if (flagEl && tooltipEl) {
    flagEl.addEventListener("mouseenter", () => {
      tooltipEl.classList.add("visible");
    });
    flagEl.addEventListener("mouseleave", () => {
      tooltipEl.classList.remove("visible");
    });

    if (hasCoords) {
      flagEl.addEventListener("click", () => {
        const mapsUrl = `https://www.google.com/maps/place/${geo.latitude},${geo.longitude}/@${geo.latitude},${geo.longitude},3z`;
        window.open(mapsUrl, "_blank");
      });
    }
  }
}

// Show login required overlay for broadcast
function showLoginRequired() {
  const broadcastView = document.getElementById("broadcast-view");
  if (!broadcastView) return;

  const overlay = document.createElement("div");
  overlay.id = "login-overlay";
  overlay.innerHTML = `
    <div class="login-required">
      <div class="watch-stream-section">
        <h2>Enter Stream ID to Watch</h2>
        <div class="watch-stream-input-row">
          <input type="text" id="watch-stream-id-input" maxlength="5" placeholder="xxxxx" autocomplete="off" spellcheck="false">
          <button id="watch-stream-go-btn" type="button" title="Go to stream">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 16 16 12 12 8"/>
              <line x1="8" y1="12" x2="16" y2="12"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="login-divider"><span>or</span></div>
      <h2>Sign in to Broadcast</h2>
      <p>Please sign in with one of the following to start broadcasting:</p>
      <div class="auth-buttons">
        <button id="overlay-login-google" class="btn btn-google">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Google
        </button>
      </div>
    </div>
  `;

  broadcastView.appendChild(overlay);
  document.getElementById("overlay-login-google")?.addEventListener("click", loginWithGoogle);

  // Watch stream functionality
  const watchInput = document.getElementById("watch-stream-id-input") as HTMLInputElement;
  const watchGoBtn = document.getElementById("watch-stream-go-btn");

  const goToStream = () => {
    const streamId = watchInput.value.trim().toLowerCase();
    if (streamId.length !== 5) {
      alert("Stream IDs are five characters long");
      watchInput.focus();
      return;
    }
    window.open(`/${streamId}`, "_blank");
  };

  watchGoBtn?.addEventListener("click", goToStream);
  watchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      goToStream();
    }
  });
  // Auto-lowercase input
  watchInput?.addEventListener("input", () => {
    watchInput.value = watchInput.value.toLowerCase();
  });
}

// Initialize broadcast view
// Optional per-request CDN override for testing individual tinymoq destinations
// (e.g. ?publisher-cdn=cdn-01.tinymoq.com, &viewer-cdn=cdn-02.tinymoq.com).
function getCdnOverride(param: "publisher-cdn" | "viewer-cdn"): string | undefined {
  const v = new URLSearchParams(window.location.search).get(param)?.trim();
  return v || undefined;
}

function initBroadcastView(streamId: string, user: User | null) {
  // The ".hang" suffix makes the catalog format explicit so the watcher can parse
  // the catalog and subscribe to video/audio tracks (otherwise detectFormat() is
  // undefined and the viewer only fetches catalog.json, never video/hd).
  const streamName = `${NAMESPACE_PREFIX}/${streamId}.hang`;
  const shareUrl = `${window.location.origin}/${streamId}`;

  console.log(`MoQplay Broadcast - Stream: ${streamId}`);

  // Show broadcast view, hide watch view
  document.getElementById("broadcast-view")?.classList.remove("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // If not logged in, show login required overlay
  if (!user) {
    showLoginRequired();
    return;
  }

  // Update the page with stream info
  const streamDisplay = document.getElementById("stream-id");
  const copyBtn = document.getElementById("copy-btn");

  if (streamDisplay) streamDisplay.textContent = streamId;

  // Copy button functionality
  if (copyBtn) {
    const copyIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    const checkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(shareUrl);
      copyBtn.innerHTML = checkIcon;
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.innerHTML = copyIcon;
        copyBtn.classList.remove("copied");
      }, 2000);
    });
  }

  // Relay-blind E2E media encryption is MANDATORY for every stream — there is no opt-out.
  // Arm the publisher at page load, BEFORE any frame is encoded, so nothing is ever
  // published in the clear; the content key arrives at go-live and releases the queued
  // frames. `streamEncrypted` is always true so goLive requires + installs the key.
  const streamEncrypted = true;
  armPublisher();

  // Stream-header indicators. "Relay-blind" is shown unconditionally — it states an
  // INFRASTRUCTURE property (the relay/server only ever move ciphertext), NOT who may
  // watch. The audience pill ("Public" / "Invite-only") carries the access claim and
  // tracks the live require-auth state below.
  let audienceBadge: HTMLSpanElement | null = null;
  const streamHeaderEl = document.querySelector(".stream-header");
  if (streamHeaderEl) {
    streamHeaderEl.appendChild(createRelayBlindBadge());
    audienceBadge = createAudienceBadge(false);
    audienceBadge.style.marginLeft = "6px";
    streamHeaderEl.appendChild(audienceBadge);
  }

  // Require auth toggle (Public vs Invite-only). Toggling re-keys the audience pill and
  // the viewer-facing access policy; the security-details disclosure (key/metadata
  // caveats) is attached next to this control.
  const requireAuthCheckbox = document.getElementById("require-auth-checkbox") as HTMLInputElement;
  if (requireAuthCheckbox) {
    // The honest caveats live right next to the access affordance.
    requireAuthCheckbox.closest("label")?.after(createSecurityDetails());

    // Load current setting
    getStreamSettings(streamId).then(settings => {
      requireAuthCheckbox.checked = settings.require_auth;
      if (audienceBadge) setAudienceBadge(audienceBadge, settings.require_auth);
    });

    // Save on change - with confirmation for anonymous viewers
    requireAuthCheckbox.addEventListener("change", async () => {
      if (requireAuthCheckbox.checked) {
        // Check for anonymous viewers before enabling auth requirement
        const data = await getStreamViewers(streamId);
        const anonymousCount = data?.viewers.filter(v => !v.user_id).length ?? 0;

        if (anonymousCount > 0) {
          const plural = anonymousCount === 1 ? "viewer is" : "viewers are";
          const confirmed = confirm(
            `${anonymousCount} anonymous ${plural} currently watching.\n\nForce them to sign in now?`
          );

          if (!confirmed) {
            // Revert checkbox if not confirmed
            requireAuthCheckbox.checked = false;
            return;
          }
        }
      }

      if (audienceBadge) setAudienceBadge(audienceBadge, requireAuthCheckbox.checked);
      updateStreamSettings(streamId, { require_auth: requireAuthCheckbox.checked });
    });
  }

  // Live chat toggle. When on, reveal the chat panel (right column on desktop, bottom
  // overlay on mobile) and connect the broadcaster to the per-stream ChatRoom; persist
  // the setting so viewers' getStreamSettings() reflects it.
  const chatCheckbox = document.getElementById("chat-checkbox") as HTMLInputElement;
  const broadcastChatPanel = document.getElementById("broadcast-chat") as HTMLElement | null;
  let chatHandle: ChatHandle | null = null;
  const openChat = () => {
    if (!broadcastChatPanel || chatHandle) return;
    broadcastChatPanel.classList.remove("hidden");
    chatHandle = initChat({ streamId, container: broadcastChatPanel, user });
  };
  const closeChat = () => {
    chatHandle?.destroy();
    chatHandle = null;
    broadcastChatPanel?.classList.add("hidden");
  };
  if (chatCheckbox) {
    getStreamSettings(streamId).then(settings => {
      chatCheckbox.checked = settings.chat_enabled;
      if (settings.chat_enabled) openChat();
    });
    chatCheckbox.addEventListener("change", () => {
      if (chatCheckbox.checked) openChat();
      else closeChat();
      updateStreamSettings(streamId, { chat_enabled: chatCheckbox.checked });
    });
  }

  // Set viewers link to stream stats page
  const viewersLink = document.getElementById("viewers-link") as HTMLAnchorElement;
  if (viewersLink) {
    viewersLink.href = `/${streamId}/stats`;
    viewersLink.target = "_blank";
    // Prevent link click from toggling the checkbox
    viewersLink.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }

  // Drive the headless <moq-publish> core element with our own control bar.
  const publisher = document.querySelector("moq-publish") as MoqPublishElement | null;
  if (publisher) {
    // The relay URL is NOT static: on go-live the Worker calls tinymoq /assign and
    // returns the relay hosting this broadcast; we point the publisher at it then.
    publisher.setAttribute("name", streamName);

    let broadcastEventId: number | null = null;
    let goLivePromise: Promise<void> | null = null;

    // First device selection = go live: get the assigned relay, then connect to it.
    // logBroadcastStart hits POST /api/stats/broadcast which calls /assign and stores
    // the relay on the broadcast row (so viewers can co-locate). Idempotent/sticky.
    const goLive = (): Promise<void> => {
      if (goLivePromise) return goLivePromise;
      goLivePromise = logBroadcastStart(streamId, getCdnOverride("publisher-cdn")).then(async (res) => {
        broadcastEventId = res?.eventId ?? null;
        const relay = res?.relay;
        const jwt = res?.jwt;
        if (!relay || !jwt) {
          // /assign failed or no token was minted — there is no static relay/token to
          // fall back to. Allow a retry on the next device action rather than
          // connecting to a dead endpoint.
          console.error("[routing] go-live got no relay/token (assign unavailable); pick a device again to retry");
          setActiveRelay(null);
          goLivePromise = null;
          return;
        }
        // Relay-blind E2E: install the per-broadcast content key BEFORE connecting,
        // so the frames the armed publisher has been queuing get encrypted. The
        // server is authoritative on whether the stream is encrypted.
        if (res?.encrypted || streamEncrypted) {
          if (!res?.contentKey) {
            console.error("[crypto] stream is encrypted but no content key was returned; not going live");
            publisher.source = null;
            setActiveRelay(null);
            goLivePromise = null;
            return;
          }
          armPublisher(); // idempotent; covers the case where settings load lost the race
          await setMediaKey(res.contentKey);
        }
        publisher.setAttribute("url", `https://${relay}/?jwt=${jwt}`);
        setActiveRelay(relay);
        console.log("[routing] broadcaster relay:", relay, "eventId:", broadcastEventId);
      });
      return goLivePromise;
    };

    // End the broadcast: mark ended + free the relay assignment (server-side /release).
    const endBroadcast = () => {
      if (broadcastEventId) {
        logBroadcastEnd(broadcastEventId);
        console.log("Broadcast ended, event ID:", broadcastEventId);
        broadcastEventId = null;
      }
      goLivePromise = null; // a later device selection re-assigns
      // Drop the content key (keep the publisher armed): a restarted broadcast
      // gets a fresh key, and frames queue until it arrives — never encrypted
      // with the previous session's key.
      resetMediaKey();
    };

    // --- Combinable capture toggles: 📹 Camera (video) + 🎤 Audio + 🖥️ Screen ---
    // Camera and/or Screen video is composited onto a single <canvas> and published as one
    // stable track (announce=true + source=undefined so the element's own capture stands
    // down); audio is mixed (mic for camera, system/tab audio for screen) into one stable
    // track. Toggling sources changes only the compositor inputs, never the published
    // tracks, so viewers never see a reset. Audio-only uses the element's native source.
    type Toggle = "camera" | "audio" | "screen";
    const capture: Record<Toggle, boolean> = { camera: false, audio: false, screen: false };
    let anyActive = false;

    // Low-level seam: a video/audio Source is just a MediaStreamTrack signal.
    const bcast = publisher.broadcast as unknown as {
      video: { source: { set(t: MediaStreamTrack | undefined): void } };
      audio: { source: { set(t: MediaStreamTrack | undefined): void } };
    };

    // Any video state (camera and/or screen) routes through ONE compositor whose canvas
    // and audio-mix tracks are published once and never re-set. Toggling camera/screen/
    // mic changes only the compositor's inputs, so the viewer never sees a track reset
    // (RESET_STREAM) — the <moq-watch> element can't re-subscribe after one and would
    // otherwise freeze. ALL capture (including audio-only) goes through the compositor so
    // the publish path never switches the element's source mode mid-broadcast — that switch
    // silently dropped audio when the sequence was audio-first-then-video.
    let comp: Compositor | null = null;
    // Video and audio sources are wired in independently and each exactly once, so a track
    // that appears later (camera added after audio-only, or vice versa) binds without
    // re-setting the other (re-setting a live track triggers RESET_STREAM → frozen viewers).
    let boundVideo = false;
    let boundAudio = false;
    const teardownComposite = () => {
      if (!comp) return;
      comp.stop();
      comp = null;
      boundVideo = false;
      boundAudio = false;
      bcast.video.source.set(undefined);
      bcast.audio.source.set(undefined);
      const v = publisher.querySelector("video") as HTMLElement | null;
      if (v) v.style.display = ""; // restore the element's own preview
    };

    // Serialize because getDisplayMedia/getUserMedia show permission prompts.
    let applying = false;
    const applyState = async () => {
      if (applying) return;
      applying = true;
      try {
        const { camera, audio, screen } = capture;
        anyActive = camera || audio || screen;
        const hasVideo = camera || screen;

        // Any active capture — video and/or audio — runs through ONE compositor path.
        // Audio-only just publishes the audio mix with no video track bound. Keeping a
        // single path is what makes the sequence order-independent.
        if (anyActive) {
          try {
            if (!comp) {
              comp = createCompositor();
              const v = publisher.querySelector("video") as HTMLElement | null;
              if (v) v.style.display = "none";
              comp.canvas.className = "pip-canvas";
              publisher.insertAdjacentElement("afterbegin", comp.canvas);
            }
            // Reconcile video sources without re-prompting the ones already captured.
            if (screen && !comp.hasScreen()) {
              await comp.enableScreen({
                onEnded: () => { capture.screen = false; syncButtons(); void applyState(); },
              });
            } else if (!screen && comp.hasScreen()) {
              comp.disableScreen();
            }
            if (camera && !comp.hasCamera()) await comp.enableCamera();
            else if (!camera && comp.hasCamera()) comp.disableCamera();

            // Audio routing: the mic is captured whenever audio is on (incl. while screen
            // sharing — for narration), and tab/system audio is additionally mixed in when a
            // screen that carries audio is shared. Both feed one stable mixed output track,
            // so toggling sources never resets the published audio.
            comp.setSystemAudioEnabled(audio && screen);
            await comp.setMicEnabled(audio);

            publisher.announce = true;
            publisher.source = undefined;
            publisher.invisible = !hasVideo; // audio-only -> no camera light / no video track
            publisher.muted = false; // the mixed audio track is always published (silent when audio off) to keep it stable
            // Bind each track once, when it first appears. Drop the video track if video
            // goes away while audio stays (so audio-only never publishes a black frame).
            if (!hasVideo && boundVideo) {
              bcast.video.source.set(undefined);
              boundVideo = false;
            } else if (hasVideo && !boundVideo) {
              bcast.video.source.set(comp.videoTrack);
              boundVideo = true;
            }
            if (!boundAudio) {
              bcast.audio.source.set(comp.audioTrack);
              boundAudio = true;
            }
            void goLive();
          } catch (e) {
            console.error("[media] capture failed (or cancelled):", e);
            capture.screen = false;
            capture.camera = false;
            syncButtons();
            teardownComposite();
          }
          return;
        }

        // Nothing active — end the broadcast and drop the compositor.
        teardownComposite();
        publisher.announce = "source";
        publisher.source = null;
        endBroadcast();
      } finally {
        applying = false;
      }
    };

    // --- Build the control bar (status + capture toggles + overlay toggle) ---
    const bar = document.createElement("div");
    bar.className = "publish-controls";

    const statusEl = document.createElement("div");
    statusEl.className = "publish-status";
    statusEl.textContent = "⚪";
    statusEl.setAttribute("data-status-text", "Offline");
    bar.appendChild(statusEl);

    const toggleButtons: Partial<Record<Toggle, HTMLButtonElement>> = {};
    const syncButtons = () => {
      (Object.keys(toggleButtons) as Toggle[]).forEach((k) => {
        toggleButtons[k]?.classList.toggle("toggle-on", capture[k]);
      });
    };
    const makeToggle = (key: Toggle, emoji: string, label: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "publish-btn toggle-btn";
      b.title = label;
      b.textContent = emoji;
      b.addEventListener("click", () => {
        capture[key] = !capture[key];
        syncButtons();
        void applyState();
      });
      toggleButtons[key] = b;
      bar.appendChild(b);
    };
    makeToggle("camera", "📹", "Camera");
    makeToggle("audio", "🎤", "Audio (microphone; also mixes in tab/system audio when screen sharing)");
    makeToggle("screen", "🖥️", "Screen");

    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "publish-btn";
    stopBtn.title = "Stop";
    stopBtn.textContent = "⏹️";
    stopBtn.addEventListener("click", () => {
      capture.camera = capture.audio = capture.screen = false;
      syncButtons();
      void applyState();
    });
    bar.appendChild(stopBtn);
    syncButtons();

    // Place the control bar directly after the <moq-publish> element.
    publisher.insertAdjacentElement("afterend", bar);

    // --- Status indicator (display only; go-live logging is handled by goLive) ---
    const refreshStatus = () => {
      const conn = publisher.connection?.status?.peek?.() ?? "disconnected";
      // anyActive covers PiP too (where state.source is undefined by design).
      const hasSource = anyActive || !!publisher.state?.source?.peek?.();
      let emoji = "⚪";
      let text = "Offline";
      if (conn === "connected" && hasSource) {
        emoji = "🟢"; text = "Live";
      } else if (conn === "connecting") {
        emoji = "🟡"; text = "Connecting";
      } else if (conn === "connected" && !hasSource) {
        emoji = "🟡"; text = "Select Device";
      }
      statusEl.textContent = emoji;
      statusEl.setAttribute("data-status-text", text);
    };
    try {
      publisher.connection?.status?.subscribe?.(refreshStatus);
      publisher.state?.source?.subscribe?.(refreshStatus);
    } catch (err) {
      console.warn("Could not subscribe to publish status signals:", err);
    }
    refreshStatus();

    // Log end on page unload
    window.addEventListener("beforeunload", () => {
      if (broadcastEventId) {
        logBroadcastEnd(broadcastEventId);
      }
    });

    // --- HTML overlay editor (broadcaster-authored HTML shown to viewers) ---
    const overlayBtn = document.createElement("button");
    overlayBtn.type = "button";
    overlayBtn.title = "HTML Overlay";
    overlayBtn.className = "publish-btn html-overlay-btn";
    overlayBtn.textContent = "</>";
    bar.appendChild(overlayBtn);

    const overlayContainer = document.createElement("div");
    overlayContainer.className = "html-overlay-container";
    overlayContainer.innerHTML = `
      <div class="html-overlay-input" contenteditable="true"></div>
      <div class="html-overlay-hint">HTML content will be displayed below the video for all viewers</div>
    `;
    const section = document.querySelector("#broadcast-view section");
    if (section && section.parentNode) {
      section.parentNode.insertBefore(overlayContainer, section.nextSibling);
    }

    const overlayInput = overlayContainer.querySelector(".html-overlay-input") as HTMLDivElement;
    let saveTimeout: number | null = null;

    // Load existing overlay content
    getStreamSettings(streamId).then((settings) => {
      if (settings.overlay_html) {
        overlayInput.textContent = settings.overlay_html;
        overlayBtn.classList.add("active");
      }
    });

    // Save overlay content with debounce
    overlayInput.addEventListener("input", () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = window.setTimeout(() => {
        const content = overlayInput.textContent || "";
        updateStreamSettings(streamId, { overlay_html: content });
        overlayBtn.classList.toggle("active", !!content.trim());
      }, 500);
    });

    // Toggle overlay input visibility
    overlayBtn.addEventListener("click", () => {
      overlayContainer.classList.toggle("visible");
      if (overlayContainer.classList.contains("visible")) {
        overlayInput.focus();
      }
    });
  }

  // New stream button
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) {
    newStreamBtn.addEventListener("click", async () => {
      const newStream = await generateStreamId();
      window.location.href = `/?stream=${newStream}`;
    });
  }
}

// Show login required overlay for watch
function showWatchLoginRequired() {
  const watchView = document.getElementById("watch-view");
  if (!watchView) return;

  const section = watchView.querySelector("section");
  if (!section) return;

  section.innerHTML = `
    <div class="login-required">
      <h2>Sign in Required</h2>
      <p>The broadcaster requires viewers to sign in to watch this stream.</p>
      <div class="auth-buttons">
        <button id="watch-login-google" class="btn btn-google">
          <svg viewBox="0 0 24 24" width="18" height="18">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Google
        </button>
      </div>
    </div>
  `;

  document.getElementById("watch-login-google")?.addEventListener("click", loginWithGoogle);
}

// Initialize watch view
// Mode C (Enterprise): turn an enterprise route into a connectable QUIC endpoint via the
// autoscaler's proven two-step /assign flow — run from the BROWSER because only it can
// reach the PRIVATE on-net relay. Step 1: tell the local relay to pull the broadcast from
// the remote edge (origin) using the cluster pull pass; it replies "host:port". Step 2 is
// the returned URL: connect there with the watchToken and subscribe to <broadcast>.
// C1 contract: auth is the BYOK watch token as a `jwt=` QUERY PARAM (not an Authorization
// header — a header would trigger a CORS preflight on this cross-origin call; a query param
// doesn't). The edge resolves the tenant by the token's kid, validates it against this
// tenant's verify_jwk, and requires a valid subscribe <broadcast> scope. No provisioning
// bearer ever enters the browser → relay-blind preserved. `origin`/`pull` are added ONLY for
// cross-pull (edge pulls the broadcast from the publisher's origin relay); in standalone mode
// the worker omits edgeHost/pullToken because the publisher is already on the edge. The
// response body is the EDGE's media endpoint "host:port" as plain text (some builds wrap it as
// JSON {relay}, so we accept both). The browser MUST dial that returned value (NOT `origin`,
// which is only the upstream the edge pulls from). The same watch token then drives the QUIC
// connect. Returns null on any failure → caller falls to B/A.
async function resolveEnterpriseConnectUrl(route: StreamRoute): Promise<string | null> {
  if (!route.broadcast || !route.watchToken) return null;
  try {
    const q = new URLSearchParams({
      broadcast: route.broadcast,
      jwt: route.watchToken, // same watch token used on the QUIC connect step
    });
    if (route.edgeHost) q.set("origin", route.edgeHost); // cross-pull only (upstream, not dialed)
    if (route.pullToken) q.set("pull", route.pullToken); // cross-pull only
    const res = await fetch(`https://${route.relay}/assign?${q.toString()}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = (await res.text()).trim();
    if (!body) return null;
    // Plain "host:port" or JSON {relay:"host:port"} (mirrors the Worker's dual-mode /assign parse).
    let hostPort = body;
    if (body.startsWith("{")) {
      try {
        hostPort = String((JSON.parse(body) as { relay?: string }).relay ?? "").trim();
      } catch {
        return null;
      }
    }
    if (!hostPort) return null;
    return `https://${hostPort}/?jwt=${route.watchToken}`;
  } catch (e) {
    console.warn("[route] enterprise /assign preflight failed", e);
    return null;
  }
}

// Mode C fallback: reload forcing ?noEnterprise=1 so the Worker skips Mode C and returns
// B/A — the viewer always ends up watching even when the private relay is unreachable.
function forceBAFallback(): void {
  const u = new URL(window.location.href);
  u.searchParams.set("noEnterprise", "1");
  window.location.replace(u.toString());
}

async function initWatchView(streamId: string, user: User | null) {
  // The ".hang" suffix makes the catalog format explicit so the watcher can parse
  // the catalog and subscribe to video/audio tracks (otherwise detectFormat() is
  // undefined and the viewer only fetches catalog.json, never video/hd).
  const streamName = `${NAMESPACE_PREFIX}/${streamId}.hang`;

  console.log(`MoQplay Watch - Stream: ${streamId}`);

  // Show watch view, hide broadcast view
  document.getElementById("watch-view")?.classList.remove("hidden");
  document.getElementById("broadcast-view")?.classList.add("hidden");

  // Hide the New Stream button on watch page
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) {
    newStreamBtn.classList.add("hidden");
  }

  // Check if stream requires auth
  const settings = await getStreamSettings(streamId);
  if (settings.require_auth && !user) {
    showWatchLoginRequired();
    return;
  }

  // Live chat for viewers, when the broadcaster enabled it (right column on desktop,
  // bottom overlay on mobile). The WS is also gated server-side on chat_enabled.
  if (settings.chat_enabled) {
    const watchChatPanel = document.getElementById("watch-chat") as HTMLElement | null;
    if (watchChatPanel) {
      watchChatPanel.classList.remove("hidden");
      initChat({ streamId, container: watchChatPanel, user });
    }
  }

  // Set stream name on watcher (headless <moq-watch> core element)
  const watcher = document.querySelector("moq-watch") as MoqWatchElement | null;
  if (watcher) {
    // --- TEMP timing probe: localize viewer join latency by phase ---
    const t0 = performance.now();
    const ms = () => `${Math.round(performance.now() - t0)}ms`;
    // Strongest "we're actually playing" signal — the Mode-C fallback watchdog reads it.
    let gotFirstFrame = false;
    const wDiag = watcher as unknown as {
      connection?: { status?: { subscribe?: (fn: (s: string) => void) => void } };
      broadcast?: { catalog?: { subscribe?: (fn: (c: unknown) => void) => void } };
    };
    try {
      wDiag.connection?.status?.subscribe?.((s) => console.log(`[watch-timing] connection ${s} @ ${ms()}`));
      let gotCatalog = false;
      wDiag.broadcast?.catalog?.subscribe?.((c) => {
        if (c && !gotCatalog) { gotCatalog = true; console.log(`[watch-timing] catalog received @ ${ms()}`); }
      });
    } catch { /* ignore */ }

    // --- Time to first frame ---
    // The renderer draws decoded frames to the <canvas> 2D context via drawImage
    // (black background uses fillRect, so drawImage = a real video frame). Hook it
    // once to capture time-to-first-frame from page load and show it in the footer.
    const canvas = watcher.querySelector("canvas") as HTMLCanvasElement | null;
    const ctx = canvas?.getContext("2d");
    if (ctx) {
      const origDrawImage = ctx.drawImage as (...a: unknown[]) => unknown;
      (ctx as unknown as { drawImage: unknown }).drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        const result = origDrawImage.apply(this, args);
        // First real frame: report, then restore the prototype method (no per-frame overhead).
        delete (ctx as unknown as { drawImage?: unknown }).drawImage;
        gotFirstFrame = true;
        const sinceLoad = performance.now(); // ms since page navigation start
        console.log(`[watch-timing] FIRST FRAME painted @ ${ms()} (from page load: ${Math.round(sinceLoad)}ms)`);
        const ttffEl = document.getElementById("ttff-display");
        if (ttffEl) {
          ttffEl.style.color = "#737373";
          ttffEl.textContent = ` | first frame: ${(sinceLoad / 1000).toFixed(2)}s`;
        }
        return result;
      };
    }

    // Co-locate on the publisher's relay: look up the broadcast→relay route.
    // Relays are islands, so the viewer MUST use the same relay as the broadcaster.
    // Falls back to the static relay if the stream isn't routed yet / lookup fails.
    const viewerCdn = getCdnOverride("viewer-cdn");
    // Optional forced cross-cluster origin (publisher relay host:port) for testing;
    // normally the Worker derives it from the publisher's stored relay in D1.
    const originOverride = new URLSearchParams(window.location.search).get("origin")?.trim() || undefined;
    if (viewerCdn) console.log("[routing] viewer CDN override:", viewerCdn, originOverride ? `(forced origin ${originOverride})` : "");

    // Resolve the relay via /route. There is NO static relay to fall back to — every
    // connection must use the dynamic host:port from the directory. If the broadcast
    // isn't live yet (404), poll until it is, showing a "waiting" state. Connect once.
    // After a failed enterprise (Mode C) attempt we reload with ?noEnterprise=1 so the
    // Worker skips Mode C and returns B/A — guaranteeing the viewer ends up watching.
    const noEnterprise = new URLSearchParams(window.location.search).get("noEnterprise") === "1";
    let routeInfo = await getStreamRoute(streamId, viewerCdn, originOverride, { noEnterprise });
    console.log(`[watch-timing] route resolved @ ${ms()} ->`, routeInfo?.relay ?? "(offline, polling)", routeInfo?.mode ? `(mode=${routeInfo.mode})` : "");

    if (!routeInfo) {
      const section = document.querySelector("#watch-view section");
      const waitingEl = document.createElement("div");
      waitingEl.className = "watch-waiting";
      waitingEl.textContent = "Waiting for broadcaster…";
      waitingEl.style.cssText = "text-align:center;padding:1.5rem;color:var(--text-muted);";
      section?.appendChild(waitingEl);

      let stopped = false;
      window.addEventListener("beforeunload", () => { stopped = true; });
      while (!routeInfo && !stopped) {
        await new Promise((r) => setTimeout(r, 1500));
        routeInfo = await getStreamRoute(streamId, viewerCdn, originOverride, { noEnterprise });
      }
      waitingEl.remove();
      if (stopped) return;
      console.log(`[watch-timing] route became available @ ${ms()} ->`, routeInfo?.relay);
    }

    if (!routeInfo) return; // stopped before a route resolved
    // Relay-blind E2E: if the stream is encrypted, arm decryption and install the
    // content key BEFORE connecting. If the key was withheld (auth-gated stream,
    // viewer not signed in) we can't decrypt — surface the sign-in requirement.
    // The content key is per-broadcast and relay-independent, so it survives any
    // later relay change in the refresh loop without re-fetching.
    if (routeInfo.encrypted) {
      if (!routeInfo.contentKey) {
        console.warn("[crypto] stream is encrypted but the content key was withheld; sign-in required to decrypt");
        showWatchLoginRequired();
        return;
      }
      armViewer();
      await setMediaKey(routeInfo.contentKey);
      // Player overlay: "Relay-blind" (always) + the audience pill. When the stream is
      // invite-only, attach the security-details disclosure so the key/metadata caveats
      // are visible right where a viewer forms a privacy expectation.
      const sec = document.querySelector("#watch-view section") as HTMLElement | null;
      if (sec) {
        if (!sec.style.position) sec.style.position = "relative";
        const overlay = document.createElement("div");
        overlay.style.cssText =
          "position:absolute;top:10px;right:10px;z-index:5;display:flex;align-items:center;" +
          "gap:8px;background:rgba(0,0,0,0.6);border-radius:999px;padding:4px 10px;";
        const rb = createRelayBlindBadge();
        rb.style.border = "none"; rb.style.padding = "0";
        const aud = createAudienceBadge(settings.require_auth);
        aud.style.border = "none"; aud.style.padding = "0";
        overlay.append(rb, aud);
        if (settings.require_auth) overlay.append(createSecurityDetails());
        sec.appendChild(overlay);
      }
    }
    if (routeInfo.mode === "enterprise") {
      // Mode C: an ASN match does NOT guarantee the user can actually reach the private
      // relay (VPN off-net, relay down…). Step 1 = /assign preflight to make it pull.
      console.log(`[route] played mode=enterprise relay=${routeInfo.relay} edge=${routeInfo.edgeHost ?? "?"}`);
      const connectUrl = await resolveEnterpriseConnectUrl(routeInfo);
      if (!connectUrl) {
        // Couldn't reach / provision the private relay — fall back to B/A right away.
        console.warn("[route] enterprise relay unreachable (/assign); falling back to B/A");
        forceBAFallback();
        return;
      }
      // Step 2: connect + subscribe. Watchdog still guards the case where /assign
      // succeeded but no frame ever paints (QUIC blocked, pull stalled…).
      setActiveRelay(routeInfo.relay);
      watcher.setAttribute("url", connectUrl);
      watcher.setAttribute("name", routeInfo.broadcast ?? streamName);
      window.setTimeout(() => {
        if (gotFirstFrame) return;
        console.warn("[route] enterprise connected but no frame; falling back to B/A");
        forceBAFallback();
      }, 6000);
    } else {
      // Modes A/B (unchanged): publisher origin relay, or a cross-cluster edge.
      // (Worker logs which of A/B; the player only sees a host:port here.)
      console.log(`[route] played mode=edge/origin relay=${routeInfo.relay}${noEnterprise ? " (enterprise fell back)" : ""}`);
      setActiveRelay(routeInfo.relay);
      watcher.setAttribute("url", `https://${routeInfo.relay}/?jwt=${routeInfo.jwt}`);
      watcher.setAttribute("name", streamName);
    }
    console.log(`[watch-timing] url set, connecting @ ${ms()}`);

    // Start muted; first click/tap on the player enables audio.
    const enableAudio = () => {
      watcher.muted = false;
      watcher.removeEventListener("click", enableAudio);
    };
    watcher.addEventListener("click", enableAudio);

    // Log watch event
    let watchEventId: number | null = null;

    // Start logging when page loads
    logWatchStart(streamId).then(id => {
      watchEventId = id;
      console.log("Watch started, event ID:", id);
    });

    // Log end on page unload
    window.addEventListener("beforeunload", () => {
      if (watchEventId) {
        logWatchEnd(watchEventId);
      }
    });

    // Create HTML overlay display div
    const watchSection = document.querySelector("#watch-view section");
    let overlayDiv = document.querySelector(".viewer-html-overlay") as HTMLDivElement;
    if (!overlayDiv && watchSection) {
      overlayDiv = document.createElement("div");
      overlayDiv.className = "viewer-html-overlay";
      watchSection.parentNode?.insertBefore(overlayDiv, watchSection.nextSibling);
    }

    // Function to update overlay content
    const updateOverlay = (overlayHtml: string) => {
      if (overlayDiv) {
        if (overlayHtml.trim()) {
          overlayDiv.innerHTML = overlayHtml;
        } else {
          overlayDiv.innerHTML = "";
        }
      }
    };

    // Load initial overlay content
    if (settings.overlay_html) {
      updateOverlay(settings.overlay_html);
    }

    // Poll for setting changes (auth and overlay)
    const settingsCheckInterval = setInterval(async () => {
      const currentSettings = await getStreamSettings(streamId);

      // Check auth requirement (anonymous viewers only)
      if (!user && currentSettings.require_auth) {
        clearInterval(settingsCheckInterval);
        if (watchEventId) {
          logWatchEnd(watchEventId);
          watchEventId = null;
        }
        showWatchLoginRequired();
        return;
      }

      // Update overlay content
      updateOverlay(currentSettings.overlay_html);
    }, 5000); // Check every 5 seconds

    // Cleanup interval on page unload
    window.addEventListener("beforeunload", () => {
      clearInterval(settingsCheckInterval);
    });
  }
}

// Initialize stats view
async function initStatsView(user: User | null) {
  console.log("MoQplay Stats");

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create stats view container
  const container = document.querySelector(".container");
  if (!container) return;

  const statsView = document.createElement("div");
  statsView.id = "stats-view";
  statsView.className = "stats-view";

  // Check if logged in
  if (!user) {
    statsView.innerHTML = `
      <div class="stats-login-required">
        <h2>Sign in Required</h2>
        <p>Please sign in to view live statistics.</p>
        <div class="auth-buttons">
          <button id="stats-login-google" class="btn btn-google">Google</button>
        </div>
      </div>
    `;
    container.appendChild(statsView);
    document.getElementById("stats-login-google")?.addEventListener("click", loginWithGoogle);
    return;
  }

  // Show loading state
  statsView.innerHTML = `<p>Loading stats...</p>`;
  container.appendChild(statsView);

  // Fetch and display stats
  const renderStats = async () => {
    const stats = await getLiveStats();
    if (!stats) {
      statsView.innerHTML = `<p class="error">Failed to load stats</p>`;
      return;
    }

    const formatTime = (dateStr: string) => {
      const date = new Date(dateStr + "Z");
      return date.toLocaleTimeString();
    };

    const formatDuration = (dateStr: string) => {
      const start = new Date(dateStr + "Z");
      const now = new Date();
      const seconds = Math.floor((now.getTime() - start.getTime()) / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${minutes % 60}m`;
    };

    const renderGeoFlag = (geo: { geo_country: string | null; geo_city: string | null; geo_region: string | null; geo_latitude: string | null; geo_longitude: string | null; geo_timezone: string | null }, id: string) => {
      const flag = countryToFlag(geo.geo_country);
      if (!flag) return "";
      const hasCoords = geo.geo_latitude && geo.geo_longitude;
      const mapsUrl = hasCoords ? `https://www.google.com/maps/place/${geo.geo_latitude},${geo.geo_longitude}/@${geo.geo_latitude},${geo.geo_longitude},3z` : null;
      const tooltip = [
        geo.geo_city,
        geo.geo_region,
        geo.geo_country,
        geo.geo_timezone,
        hasCoords ? `${geo.geo_latitude}, ${geo.geo_longitude}` : null
      ].filter(Boolean).join(" | ");
      return `<span class="stats-flag ${hasCoords ? 'clickable' : ''}" data-id="${id}" data-url="${mapsUrl || ''}" title="${tooltip}">${flag}</span>`;
    };

    const broadcastRows = stats.broadcasts.length === 0
      ? `<tr><td colspan="5" class="empty">No active broadcasts</td></tr>`
      : stats.broadcasts.map((b: LiveBroadcast) => `
          <tr>
            <td><a href="/${b.stream_id}" target="_blank">${b.stream_id}</a></td>
            <td>
              ${b.avatar_url ? `<img src="${b.avatar_url}" class="avatar-small">` : ""}
              ${b.user_name || b.user_email}
            </td>
            <td>${renderGeoFlag(b, `b-${b.id}`)}</td>
            <td>${formatDuration(b.started_at)}</td>
            <td>${stats.viewers.filter((v: LiveViewer) => v.stream_id === b.stream_id).length}</td>
          </tr>
        `).join("");

    const viewerRows = stats.viewers.length === 0
      ? `<tr><td colspan="4" class="empty">No active viewers</td></tr>`
      : stats.viewers.map((v: LiveViewer) => `
          <tr>
            <td><a href="/${v.stream_id}" target="_blank">${v.stream_id}</a></td>
            <td>
              ${v.avatar_url ? `<img src="${v.avatar_url}" class="avatar-small">` : ""}
              ${v.user_name || v.user_email || "Anonymous"}
            </td>
            <td>${renderGeoFlag(v, `v-${v.id}`)}</td>
            <td>${formatDuration(v.started_at)}</td>
          </tr>
        `).join("");

    statsView.innerHTML = `
      <h2>Live Statistics</h2>
      <div class="stats-grid">
        <section class="stats-section">
          <h3>Active Broadcasts (${stats.broadcasts.length})</h3>
          <table class="stats-table">
            <thead>
              <tr>
                <th>Stream</th>
                <th>Broadcaster</th>
                <th>Location</th>
                <th>Duration</th>
                <th>Viewers</th>
              </tr>
            </thead>
            <tbody>${broadcastRows}</tbody>
          </table>
        </section>
        <section class="stats-section">
          <h3>Active Viewers (${stats.viewers.length})</h3>
          <table class="stats-table">
            <thead>
              <tr>
                <th>Stream</th>
                <th>Viewer</th>
                <th>Location</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>${viewerRows}</tbody>
          </table>
        </section>
      </div>
      <button id="refresh-stats" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
    `;

    // Add click handlers for flags
    statsView.querySelectorAll(".stats-flag.clickable").forEach((el) => {
      el.addEventListener("click", () => {
        const url = (el as HTMLElement).dataset.url;
        if (url) window.open(url, "_blank");
      });
    });

    document.getElementById("refresh-stats")?.addEventListener("click", renderStats);
  };

  await renderStats();
}

// Initialize stream-specific stats view (viewers only)
async function initStreamStatsView(streamId: string) {
  console.log(`MoQplay Stream Stats - Stream: ${streamId}`);

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create stats view container
  const container = document.querySelector(".container");
  if (!container) return;

  const statsView = document.createElement("div");
  statsView.id = "stream-stats-view";
  statsView.className = "stats-view";

  // Show loading state
  statsView.innerHTML = `<p>Loading viewers...</p>`;
  container.appendChild(statsView);

  // Fetch and display viewers
  const renderViewers = async () => {
    const data = await getStreamViewers(streamId);
    if (!data) {
      statsView.innerHTML = `<p class="error">Failed to load viewers</p>`;
      return;
    }

    const formatDuration = (dateStr: string) => {
      const start = new Date(dateStr + "Z");
      const now = new Date();
      const seconds = Math.floor((now.getTime() - start.getTime()) / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
      const hours = Math.floor(minutes / 60);
      return `${hours}h ${minutes % 60}m`;
    };

    const renderGeoFlag = (geo: { geo_country: string | null; geo_city: string | null; geo_region: string | null; geo_latitude: string | null; geo_longitude: string | null; geo_timezone: string | null }, id: string) => {
      const flag = countryToFlag(geo.geo_country);
      if (!flag) return "";
      const hasCoords = geo.geo_latitude && geo.geo_longitude;
      const mapsUrl = hasCoords ? `https://www.google.com/maps/place/${geo.geo_latitude},${geo.geo_longitude}/@${geo.geo_latitude},${geo.geo_longitude},3z` : null;
      const tooltip = [
        geo.geo_city,
        geo.geo_region,
        geo.geo_country,
        geo.geo_timezone,
        hasCoords ? `${geo.geo_latitude}, ${geo.geo_longitude}` : null
      ].filter(Boolean).join(" | ");
      return `<span class="stats-flag ${hasCoords ? 'clickable' : ''}" data-id="${id}" data-url="${mapsUrl || ''}" title="${tooltip}">${flag}</span>`;
    };

    const viewerRows = data.viewers.length === 0
      ? `<tr><td colspan="3" class="empty">No active viewers</td></tr>`
      : data.viewers.map((v: LiveViewer) => `
          <tr>
            <td>
              ${v.avatar_url ? `<img src="${v.avatar_url}" class="avatar-small">` : ""}
              ${v.user_name || v.user_email || "Anonymous"}
            </td>
            <td>${renderGeoFlag(v, `v-${v.id}`)}</td>
            <td>${formatDuration(v.started_at)}</td>
          </tr>
        `).join("");

    statsView.innerHTML = `
      <h2>Viewers for <a href="/${streamId}" class="stream-link">${streamId}</a></h2>
      <p><a href="/${streamId}/stats/map" class="view-toggle" title="View Map">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
          <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/>
          <line x1="8" y1="2" x2="8" y2="18"/>
          <line x1="16" y1="6" x2="16" y2="22"/>
        </svg>
      </a></p>
      <section class="stats-section">
        <h3>Active Viewers (${data.viewers.length})</h3>
        <table class="stats-table">
          <thead>
            <tr>
              <th>Viewer</th>
              <th>Location</th>
              <th>Watching for</th>
            </tr>
          </thead>
          <tbody>${viewerRows}</tbody>
        </table>
      </section>
      <button id="refresh-stream-stats" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
    `;

    // Add click handlers for flags
    statsView.querySelectorAll(".stats-flag.clickable").forEach((el) => {
      el.addEventListener("click", () => {
        const url = (el as HTMLElement).dataset.url;
        if (url) window.open(url, "_blank");
      });
    });

    document.getElementById("refresh-stream-stats")?.addEventListener("click", renderViewers);
  };

  await renderViewers();
}

// Initialize stats map view (all viewers on a map)
async function initStatsMapView(user: User | null) {
  console.log("MoQplay Stats Map");

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create map view container
  const container = document.querySelector(".container");
  if (!container) return;

  const mapView = document.createElement("div");
  mapView.id = "stats-map-view";
  mapView.className = "stats-view";

  // Check if logged in
  if (!user) {
    mapView.innerHTML = `
      <div class="stats-login-required">
        <h2>Sign in Required</h2>
        <p>Please sign in to view the live map.</p>
        <div class="auth-buttons">
          <button id="map-login-google" class="btn btn-google">Google</button>
        </div>
      </div>
    `;
    container.appendChild(mapView);
    document.getElementById("map-login-google")?.addEventListener("click", loginWithGoogle);
    return;
  }

  mapView.innerHTML = `
    <h2>Live Viewer Map</h2>
    <p><a href="/stats" class="view-toggle" title="View Table">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="3" y1="9" x2="21" y2="9"/>
        <line x1="3" y1="15" x2="21" y2="15"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
      </svg>
    </a></p>
    <div id="leaflet-map" style="height: 500px; border-radius: 8px; margin-top: 1rem;"></div>
    <button id="refresh-map" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
  `;
  container.appendChild(mapView);

  const renderMap = async () => {
    const stats = await getLiveStats();
    if (!stats) return;

    const mapEl = document.getElementById("leaflet-map");
    if (!mapEl) return;

    // Clear existing map
    mapEl.innerHTML = "";

    // @ts-expect-error Leaflet loaded from CDN
    const map = L.map("leaflet-map").setView([20, 0], 2);

    // @ts-expect-error Leaflet loaded from CDN
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: '&copy; Esri'
    }).addTo(map);

    // Add viewer markers (blue)
    stats.viewers.forEach((v: LiveViewer) => {
      if (v.geo_latitude && v.geo_longitude) {
        const lat = parseFloat(v.geo_latitude);
        const lng = parseFloat(v.geo_longitude);
        const name = v.user_name || v.user_email || "Anonymous";
        const location = [v.geo_city, v.geo_region, v.geo_country].filter(Boolean).join(", ");
        // @ts-expect-error Leaflet loaded from CDN
        L.marker([lat, lng], {
          // @ts-expect-error Leaflet loaded from CDN
          icon: L.divIcon({
            className: "viewer-marker",
            html: `<div style="background: #3b82f6; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6]
          })
        })
          .addTo(map)
          .bindPopup(`<strong>${name}</strong><br>Watching: ${v.stream_id}<br>${location}`);
      }
    });

    // Add broadcaster markers (red)
    stats.broadcasts.forEach((b: LiveBroadcast) => {
      if (b.geo_latitude && b.geo_longitude) {
        const lat = parseFloat(b.geo_latitude);
        const lng = parseFloat(b.geo_longitude);
        const name = b.user_name || b.user_email;
        const location = [b.geo_city, b.geo_region, b.geo_country].filter(Boolean).join(", ");
        // @ts-expect-error Leaflet loaded from CDN
        L.marker([lat, lng], {
          // @ts-expect-error Leaflet loaded from CDN
          icon: L.divIcon({
            className: "broadcaster-marker",
            html: `<div style="background: #ef4444; width: 16px; height: 16px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8]
          })
        })
          .addTo(map)
          .bindPopup(`<strong>${name}</strong> (Broadcaster)<br>Stream: ${b.stream_id}<br>${location}`);
      }
    });
  };

  await renderMap();
  document.getElementById("refresh-map")?.addEventListener("click", renderMap);
}

// Initialize stream-specific stats map view (viewers for one stream on a map)
async function initStreamStatsMapView(streamId: string) {
  console.log(`MoQplay Stream Stats Map - Stream: ${streamId}`);

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create map view container
  const container = document.querySelector(".container");
  if (!container) return;

  const mapView = document.createElement("div");
  mapView.id = "stream-stats-map-view";
  mapView.className = "stats-view";

  mapView.innerHTML = `
    <h2>Viewer Map for <a href="/${streamId}" class="stream-link">${streamId}</a></h2>
    <p><a href="/${streamId}/stats" class="view-toggle" title="View Table">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <line x1="3" y1="9" x2="21" y2="9"/>
        <line x1="3" y1="15" x2="21" y2="15"/>
        <line x1="9" y1="3" x2="9" y2="21"/>
      </svg>
    </a></p>
    <div id="leaflet-map" style="height: 500px; border-radius: 8px; margin-top: 1rem;"></div>
    <button id="refresh-stream-map" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
  `;
  container.appendChild(mapView);

  const renderMap = async () => {
    const data = await getStreamViewers(streamId);
    if (!data) return;

    const mapEl = document.getElementById("leaflet-map");
    if (!mapEl) return;

    // Clear existing map
    mapEl.innerHTML = "";

    // @ts-expect-error Leaflet loaded from CDN
    const map = L.map("leaflet-map").setView([20, 0], 2);

    // @ts-expect-error Leaflet loaded from CDN
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: '&copy; Esri'
    }).addTo(map);

    // Add viewer markers
    data.viewers.forEach((v: LiveViewer) => {
      if (v.geo_latitude && v.geo_longitude) {
        const lat = parseFloat(v.geo_latitude);
        const lng = parseFloat(v.geo_longitude);
        const name = v.user_name || v.user_email || "Anonymous";
        const location = [v.geo_city, v.geo_region, v.geo_country].filter(Boolean).join(", ");
        // @ts-expect-error Leaflet loaded from CDN
        L.marker([lat, lng], {
          // @ts-expect-error Leaflet loaded from CDN
          icon: L.divIcon({
            className: "viewer-marker",
            html: `<div style="background: #3b82f6; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3);"></div>`,
            iconSize: [12, 12],
            iconAnchor: [6, 6]
          })
        })
          .addTo(map)
          .bindPopup(`<strong>${name}</strong><br>${location}`);
      }
    });

    // Fit bounds if there are markers
    const viewersWithGeo = data.viewers.filter((v: LiveViewer) => v.geo_latitude && v.geo_longitude);
    if (viewersWithGeo.length > 0) {
      // @ts-expect-error Leaflet loaded from CDN
      const bounds = L.latLngBounds(
        viewersWithGeo.map((v: LiveViewer) => [parseFloat(v.geo_latitude!), parseFloat(v.geo_longitude!)])
      );
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 4 });
    }
  };

  await renderMap();
  document.getElementById("refresh-stream-map")?.addEventListener("click", renderMap);
}

// Initialize greet view (broadcasters only map - public)
async function initGreetView() {
  console.log("MoQplay Greet - Live Broadcasters");

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create greet view container
  const container = document.querySelector(".container");
  if (!container) return;

  const greetView = document.createElement("div");
  greetView.id = "greet-view";
  greetView.className = "stats-view";

  greetView.innerHTML = `
    <h2>Live Broadcasts</h2>
    <p class="greet-subtitle">Click a marker to watch</p>
    <div id="leaflet-map" style="height: 600px; border-radius: 8px; margin-top: 1rem;"></div>
    <button id="refresh-greet" class="btn btn-primary" style="margin-top: 1rem;">Refresh</button>
  `;
  container.appendChild(greetView);

  interface GreetBroadcast {
    id: number;
    stream_id: string;
    started_at: string;
    user_name: string;
    geo_country: string | null;
    geo_city: string | null;
    geo_region: string | null;
    geo_latitude: string | null;
    geo_longitude: string | null;
    viewer_count: number;
  }

  const renderMap = async () => {
    // Fetch broadcasts from public greet endpoint
    const response = await fetch("/api/stats/greet");
    if (!response.ok) {
      const mapEl = document.getElementById("leaflet-map");
      if (mapEl) {
        mapEl.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #737373;">Failed to load broadcasts</div>`;
      }
      return;
    }
    const data = await response.json() as { broadcasts: GreetBroadcast[] };

    const mapEl = document.getElementById("leaflet-map");
    if (!mapEl) return;

    // Clear existing map
    mapEl.innerHTML = "";

    // @ts-expect-error Leaflet loaded from CDN
    const map = L.map("leaflet-map").setView([20, 0], 2);

    // @ts-expect-error Leaflet loaded from CDN
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: '&copy; Esri &mdash; Esri, DeLorme, NAVTEQ'
    }).addTo(map);

    // Add broadcaster markers (red) with viewer count
    data.broadcasts.forEach((b: GreetBroadcast) => {
      if (b.geo_latitude && b.geo_longitude) {
        const lat = parseFloat(b.geo_latitude);
        const lng = parseFloat(b.geo_longitude);
        const name = b.user_name || "Broadcaster";
        const location = [b.geo_city, b.geo_region, b.geo_country].filter(Boolean).join(", ");
        const viewers = b.viewer_count || 0;

        // @ts-expect-error Leaflet loaded from CDN
        const marker = L.marker([lat, lng], {
          // @ts-expect-error Leaflet loaded from CDN
          icon: L.divIcon({
            className: "broadcaster-marker",
            html: `<div style="background: #ef4444; width: 20px; height: 20px; border-radius: 50%; border: 3px solid white; box-shadow: 0 2px 8px rgba(0,0,0,0.4); cursor: pointer;"></div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
          })
        }).addTo(map);

        // Tooltip on hover showing viewer count
        marker.bindTooltip(`<strong>${name}</strong><br>${location}<br><span style="color: #3b82f6;">${viewers} viewer${viewers !== 1 ? 's' : ''}</span>`, {
          direction: 'top',
          offset: [0, -10]
        });

        // Click to open watch page in new tab
        marker.on('click', () => {
          window.open(`/${b.stream_id}`, '_blank');
        });
      }
    });

    // If no broadcasters with geo, show message
    const broadcastersWithGeo = data.broadcasts.filter((b: GreetBroadcast) => b.geo_latitude && b.geo_longitude);
    if (broadcastersWithGeo.length === 0) {
      mapEl.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #737373;">No live broadcasts at the moment</div>`;
    }
  };

  await renderMap();
  document.getElementById("refresh-greet")?.addEventListener("click", renderMap);
}

// Initialize admin view
function initAdminView() {
  console.log("MoQplay Admin Panel");

  // Hide broadcast and watch views
  document.getElementById("broadcast-view")?.classList.add("hidden");
  document.getElementById("watch-view")?.classList.add("hidden");

  // Hide footer and new stream button
  const footer = document.querySelector("footer");
  if (footer) footer.classList.add("hidden");
  const newStreamBtn = document.getElementById("new-stream-btn");
  if (newStreamBtn) newStreamBtn.classList.add("hidden");

  // Create admin view container
  const container = document.querySelector(".container");
  if (!container) return;

  const adminView = document.createElement("div");
  adminView.id = "admin-view";
  adminView.className = "stats-view";

  adminView.innerHTML = `
    <h2>Admin Panel</h2>
    <div id="admin-login" class="stats-section" style="max-width: 400px; margin: 2rem auto;">
      <h3>Password Required</h3>
      <div style="display: flex; flex-direction: column; gap: 1rem; margin-top: 1rem;">
        <input type="password" id="admin-password" placeholder="Enter admin password"
          style="background: #262626; border: 1px solid #404040; border-radius: 6px; padding: 0.75rem; color: #e5e5e5; font-size: 1rem;">
        <button id="admin-login-btn" class="btn btn-primary">Login</button>
        <p id="admin-error" style="color: #ef4444; display: none; text-align: center;"></p>
      </div>
    </div>
    <div id="admin-panel" style="max-width: 720px; margin: 2rem auto; display: none;">
    <div class="stats-section" style="margin-bottom: 1.5rem;">
      <h3>Broadcaster Access</h3>
      <p style="color: #a3a3a3; margin-bottom: 1rem;">
        Default-deny: only <strong>allowed</strong> accounts can broadcast. Suspend or remove to block.
      </p>
      <div style="display: flex; gap: 0.5rem; margin-bottom: 1.5rem;">
        <input type="email" id="add-email-input" placeholder="email@example.com" autocomplete="off" spellcheck="false"
          style="flex: 1; background: #262626; border: 1px solid #404040; border-radius: 6px; padding: 0.6rem; color: #e5e5e5; font-size: 0.95rem;">
        <button id="add-allow-btn" class="btn btn-primary">Allow</button>
      </div>
      <div id="broadcasters-list" style="display: flex; flex-direction: column; gap: 0.5rem;">
        <p style="color: #737373;">Loading…</p>
      </div>
      <div id="access-status" style="margin-top: 1rem; padding: 0.75rem; border-radius: 6px; display: none;"></div>
    </div>
    <div class="stats-section">
      <h3>Data Management</h3>
      <p style="color: #a3a3a3; margin-bottom: 1.5rem;">Warning: These actions are irreversible.</p>
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <button id="clear-broadcasts-btn" class="btn" style="background: #7f1d1d; border-color: #991b1b;">
          Clear All Broadcaster Data
        </button>
        <button id="clear-viewers-btn" class="btn" style="background: #7f1d1d; border-color: #991b1b;">
          Clear All Viewer Data
        </button>
      </div>
      <div id="admin-status" style="margin-top: 1rem; padding: 0.75rem; border-radius: 6px; display: none;"></div>
    </div>
    </div>
  `;
  container.appendChild(adminView);

  let adminPassword = "";

  const showStatus = (message: string, isError: boolean) => {
    const statusEl = document.getElementById("admin-status");
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.style.display = "block";
      statusEl.style.background = isError ? "#7f1d1d" : "#14532d";
      statusEl.style.color = "#e5e5e5";
    }
  };

  const showAccessStatus = (message: string, isError: boolean) => {
    const el = document.getElementById("access-status");
    if (!el) return;
    el.textContent = message;
    el.style.display = "block";
    el.style.background = isError ? "#7f1d1d" : "#14532d";
    el.style.color = "#e5e5e5";
  };

  type Broadcaster = {
    email: string;
    name: string | null;
    avatar_url: string | null;
    status: string; // 'allowed' | 'suspended' | 'none'
    last_broadcast: string | null;
    never_signed_in?: boolean;
  };

  // Build one broadcaster row with avatar, identity, status badge, and actions.
  const renderBroadcaster = (b: Broadcaster): HTMLElement => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:0.75rem;padding:0.6rem 0.75rem;background:#1f1f1f;border:1px solid #333;border-radius:6px;";

    if (b.avatar_url) {
      const img = document.createElement("img");
      img.src = b.avatar_url;
      img.alt = "";
      img.style.cssText = "width:32px;height:32px;border-radius:50%;flex-shrink:0;";
      row.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.style.cssText = "width:32px;height:32px;border-radius:50%;flex-shrink:0;background:#3b82f6;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;";
      ph.textContent = (b.name || b.email).charAt(0).toUpperCase();
      row.appendChild(ph);
    }

    const info = document.createElement("div");
    info.style.cssText = "flex:1;min-width:0;";
    const nameEl = document.createElement("div");
    nameEl.style.cssText = "color:#e5e5e5;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    nameEl.textContent = b.name || b.email;
    const subEl = document.createElement("div");
    subEl.style.cssText = "color:#737373;font-size:0.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
    subEl.textContent = b.never_signed_in ? `${b.email} · never signed in` : b.email;
    info.appendChild(nameEl);
    info.appendChild(subEl);
    row.appendChild(info);

    const badge = document.createElement("span");
    const label = b.status === "allowed" ? "allowed" : b.status === "suspended" ? "suspended" : "blocked";
    const color = b.status === "allowed" ? "#22c55e" : b.status === "suspended" ? "#f59e0b" : "#737373";
    badge.textContent = label;
    badge.style.cssText = `color:${color};font-size:0.8rem;font-weight:600;flex-shrink:0;`;
    row.appendChild(badge);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:0.4rem;flex-shrink:0;";
    const mkBtn = (text: string, bg: string, fn: () => void) => {
      const btn = document.createElement("button");
      btn.textContent = text;
      btn.className = "btn";
      btn.style.cssText = `padding:0.3rem 0.7rem;font-size:0.85rem;background:${bg};border-color:${bg};`;
      btn.addEventListener("click", fn);
      return btn;
    };
    if (b.status === "allowed") {
      actions.appendChild(mkBtn("Suspend", "#92400e", () => setAccess(b.email, "suspended")));
    } else {
      actions.appendChild(mkBtn("Allow", "#15803d", () => setAccess(b.email, "allowed")));
    }
    if (b.status !== "none") {
      actions.appendChild(mkBtn("Remove", "#7f1d1d", () => removeAccess(b.email)));
    }
    row.appendChild(actions);

    return row;
  };

  const loadBroadcasters = async () => {
    const listEl = document.getElementById("broadcasters-list");
    if (!listEl) return;
    try {
      const res = await fetch("/api/admin/broadcasters", {
        headers: { "Authorization": `Bearer ${adminPassword}` },
      });
      if (!res.ok) {
        listEl.innerHTML = "";
        showAccessStatus("Failed to load broadcasters", true);
        return;
      }
      const data = await res.json() as { broadcasters: Broadcaster[] };
      listEl.innerHTML = "";
      if (!data.broadcasters.length) {
        const p = document.createElement("p");
        p.style.color = "#737373";
        p.textContent = "No accounts yet. Add an email above to pre-authorize.";
        listEl.appendChild(p);
        return;
      }
      for (const b of data.broadcasters) listEl.appendChild(renderBroadcaster(b));
    } catch {
      showAccessStatus("Connection error", true);
    }
  };

  const setAccess = async (email: string, status: "allowed" | "suspended") => {
    try {
      const res = await fetch("/api/admin/broadcasters", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${adminPassword}` },
        body: JSON.stringify({ email, status }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        showAccessStatus(d.error || "Failed to update access", true);
        return;
      }
      showAccessStatus(`${email} is now ${status}.`, false);
      loadBroadcasters();
    } catch {
      showAccessStatus("Connection error", true);
    }
  };

  const removeAccess = async (email: string) => {
    if (!confirm(`Remove ${email} from the allow list? They will no longer be able to broadcast.`)) return;
    try {
      const res = await fetch(`/api/admin/broadcasters?email=${encodeURIComponent(email)}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${adminPassword}` },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        showAccessStatus(d.error || "Failed to remove", true);
        return;
      }
      showAccessStatus(`${email} removed from the allow list.`, false);
      loadBroadcasters();
    } catch {
      showAccessStatus("Connection error", true);
    }
  };

  const addEmail = () => {
    const input = document.getElementById("add-email-input") as HTMLInputElement;
    const email = input?.value.trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      showAccessStatus("Enter a valid email address.", true);
      return;
    }
    setAccess(email, "allowed");
    input.value = "";
  };

  document.getElementById("add-allow-btn")?.addEventListener("click", addEmail);
  document.getElementById("add-email-input")?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") addEmail();
  });

  // Login handler
  document.getElementById("admin-login-btn")?.addEventListener("click", async () => {
    const passwordInput = document.getElementById("admin-password") as HTMLInputElement;
    const errorEl = document.getElementById("admin-error");
    adminPassword = passwordInput?.value || "";

    // Verify the password
    try {
      const response = await fetch("/api/admin/verify", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${adminPassword}`
        }
      });

      // If we get 401, password is wrong
      if (response.status === 401) {
        if (errorEl) {
          errorEl.textContent = "Invalid password";
          errorEl.style.display = "block";
        }
        return;
      }

      // Password is correct, show the admin panel
      document.getElementById("admin-login")!.style.display = "none";
      document.getElementById("admin-panel")!.style.display = "block";
      loadBroadcasters();
    } catch {
      if (errorEl) {
        errorEl.textContent = "Connection error";
        errorEl.style.display = "block";
      }
    }
  });

  // Clear broadcasts handler
  document.getElementById("clear-broadcasts-btn")?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to clear ALL broadcaster data? This cannot be undone.")) {
      return;
    }

    try {
      const response = await fetch("/api/admin/broadcasts", {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${adminPassword}`
        }
      });

      if (response.ok) {
        showStatus("All broadcaster data has been cleared.", false);
      } else {
        const data = await response.json();
        showStatus(data.error || "Failed to clear data", true);
      }
    } catch {
      showStatus("Connection error", true);
    }
  });

  // Clear viewers handler
  document.getElementById("clear-viewers-btn")?.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to clear ALL viewer data? This cannot be undone.")) {
      return;
    }

    try {
      const response = await fetch("/api/admin/viewers", {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${adminPassword}`
        }
      });

      if (response.ok) {
        showStatus("All viewer data has been cleared.", false);
      } else {
        const data = await response.json();
        showStatus(data.error || "Failed to clear data", true);
      }
    } catch {
      showStatus("Connection error", true);
    }
  });

  // Handle enter key on password input
  document.getElementById("admin-password")?.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      document.getElementById("admin-login-btn")?.click();
    }
  });
}

// Initialize the app
// TEMP diagnostic: time WebTransport bidi-stream creation. If a stream takes
// ~15s to OPEN after being requested, the stall is QUIC stream-credit/flow-control
// (relay grants MAX_STREAMS slowly) — NOT client logic. If "called" itself is late,
// it's client-side. Distinguishes the two for the ~15s subscribe gaps.
function instrumentWebTransportStreams() {
  if (typeof WebTransport === "undefined") return;
  const proto = WebTransport.prototype as unknown as {
    __streamTimed?: boolean;
    createBidirectionalStream: (...args: unknown[]) => Promise<unknown>;
  };
  if (proto.__streamTimed) return;
  proto.__streamTimed = true;
  const orig = proto.createBidirectionalStream;
  let n = 0;
  proto.createBidirectionalStream = function (this: unknown, ...args: unknown[]) {
    const i = ++n;
    if (i > 8) return orig.apply(this, args);
    const t = performance.now();
    console.log(`[wt-stream] #${i} createBidirectionalStream() called @ ${Math.round(t)}ms`);
    const p = orig.apply(this, args);
    Promise.resolve(p).then(
      () => console.log(`[wt-stream] #${i} OPENED after ${Math.round(performance.now() - t)}ms`),
      (e: unknown) => console.log(`[wt-stream] #${i} failed after ${Math.round(performance.now() - t)}ms`, e)
    );
    return p;
  };
}

// TEMP diagnostic: prefix every console line with a wall-clock timestamp
// (HH:MM:SS.mmm) so the @moq MoQ request logs (connected, negotiated ALPN,
// announced, subscribe start/ok catalog.json + video/hd, received catalog,
// sync[video]) can be correlated directly against the relay's server-side timeline.
function timestampConsole() {
  const w = window as unknown as { __consoleTimestamped?: boolean };
  if (w.__consoleTimestamped) return;
  w.__consoleTimestamped = true;
  (["debug", "log", "info", "warn", "error"] as const).forEach((m) => {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]) => orig(`[${new Date().toISOString().slice(11, 23)}]`, ...args);
  });
}

async function init() {
  timestampConsole();
  instrumentWebTransportStreams();
  // Detect browser support (async for codec checks)
  browserSupport = await detectBrowserSupport();

  // For Safari/polyfill mode, select the best relay server based on latency
  if (needsPolyfill) {
    // Safari/polyfill path is disabled (tinymoq is WebTransport-only); kept for the
    // serverStatus side effect only. No static relay URL is used anymore — relays and
    // per-broadcast tokens are resolved dynamically at go-live / watch time.
    await selectBestFallbackRelay();
  } else {
    // WebTransport mode - assume connected
    serverStatus.connected = true;
  }

  // Update status panels
  updateBrowserSupportPanel();
  updateServerStatusPanel();

  // Load hang components dynamically AFTER polyfill is installed
  await loadHangComponents();

  const { view, streamId } = await getRouteInfo();

  // Get user first (needed for broadcast auth check)
  const { user, geo } = await getCurrentUser();
  updateAuthUI(user, geo);

  if (view === "broadcast") {
    initBroadcastView(streamId, user);
  } else if (view === "stats") {
    await initStatsView(user);
  } else if (view === "stats-map") {
    await initStatsMapView(user);
  } else if (view === "greet") {
    await initGreetView();
  } else if (view === "stream-stats") {
    await initStreamStatsView(streamId);
  } else if (view === "stream-stats-map") {
    await initStreamStatsMapView(streamId);
  } else if (view === "admin") {
    initAdminView();
  } else {
    await initWatchView(streamId, user);
  }

  // Browser support toggle
  const supportLink = document.getElementById("support-link");
  const supportPanel = document.getElementById("support-panel");
  if (supportLink && supportPanel) {
    supportLink.addEventListener("click", (e) => {
      e.preventDefault();
      supportPanel.classList.toggle("hidden");
    });
  }

  // Server status toggle
  const serverLink = document.getElementById("server-link");
  const serverPanel = document.getElementById("server-panel");
  if (serverLink && serverPanel) {
    serverLink.addEventListener("click", (e) => {
      e.preventDefault();
      serverPanel.classList.toggle("hidden");
    });
  }
}

// Run when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
