// Per-stream live chat, backed by a Durable Object using the WebSocket Hibernation
// API (no duration charges while idle). One instance per streamId. Every connected
// socket — broadcaster and viewers — receives every message; the last N are kept so
// late joiners see recent context. Display names are client-supplied and ephemeral;
// the DO trusts nothing and sanitizes length only (clients render with textContent,
// so message text is never interpreted as HTML).

interface ChatMsg {
  id: string;
  name: string;
  text: string;
  ts: number;
}

const MAX_HISTORY = 50;
const MAX_TEXT = 500;
const MAX_NAME = 32;
const MIN_INTERVAL_MS = 250; // light per-connection anti-flood throttle

export class ChatRoom {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernatable: the DO can be evicted between messages and revived on the next one.
    this.state.acceptWebSocket(server);
    const history = (await this.state.storage.get<ChatMsg[]>("history")) ?? [];
    server.send(JSON.stringify({ type: "history", messages: history }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let data: { name?: unknown; text?: unknown };
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // Anti-flood: drop messages that arrive faster than MIN_INTERVAL_MS on one socket.
    // serializeAttachment survives hibernation, so the throttle persists across eviction.
    const now = Date.now();
    const last = (ws.deserializeAttachment() as { t?: number } | null)?.t ?? 0;
    if (now - last < MIN_INTERVAL_MS) return;

    const text = String(data.text ?? "").slice(0, MAX_TEXT).trim();
    if (!text) return;
    const name = String(data.name ?? "").slice(0, MAX_NAME).trim() || "Guest";

    ws.serializeAttachment({ t: now });

    const msg: ChatMsg = { id: crypto.randomUUID(), name, text, ts: now };
    let history = (await this.state.storage.get<ChatMsg[]>("history")) ?? [];
    history.push(msg);
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    await this.state.storage.put("history", history);

    const payload = JSON.stringify({ type: "msg", ...msg });
    for (const sock of this.state.getWebSockets()) {
      try {
        sock.send(payload);
      } catch {
        // socket going away; ignore
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code);
    } catch {
      // already closing
    }
  }
}
