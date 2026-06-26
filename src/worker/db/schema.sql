-- Users table for OAuth authentication
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_id TEXT UNIQUE,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for fast provider ID lookups during OAuth
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);

-- Broadcast events - logged when a user starts broadcasting
CREATE TABLE IF NOT EXISTS broadcast_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  stream_id TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  -- Geolocation data from Cloudflare
  geo_country TEXT,
  geo_city TEXT,
  geo_region TEXT,
  geo_latitude TEXT,
  geo_longitude TEXT,
  geo_timezone TEXT,
  -- Assigned tinymoq relay (broadcast→relay routing directory)
  relay_host TEXT,
  relay_port INTEGER,
  -- Per-broadcast content encryption key (base64url, 256-bit) for relay-blind
  -- E2E media encryption. NULL when the stream is not encrypted. Never sent to
  -- the relay; handed to the publisher at go-live and to authorized viewers.
  content_key TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_broadcast_events_user_id ON broadcast_events(user_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_events_stream_id ON broadcast_events(stream_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_events_started_at ON broadcast_events(started_at);

-- Watch events - logged when someone watches a stream
CREATE TABLE IF NOT EXISTS watch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  stream_id TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  -- Geolocation data from Cloudflare
  geo_country TEXT,
  geo_city TEXT,
  geo_region TEXT,
  geo_latitude TEXT,
  geo_longitude TEXT,
  geo_timezone TEXT
);

CREATE INDEX IF NOT EXISTS idx_watch_events_user_id ON watch_events(user_id);
CREATE INDEX IF NOT EXISTS idx_watch_events_stream_id ON watch_events(stream_id);
CREATE INDEX IF NOT EXISTS idx_watch_events_started_at ON watch_events(started_at);

-- Stream settings - stores per-stream configuration
CREATE TABLE IF NOT EXISTS streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  require_auth INTEGER DEFAULT 0,
  -- Broadcaster-supplied HTML overlay rendered over the player.
  overlay_html TEXT DEFAULT '',
  -- Relay-blind E2E media encryption opt-in (1 = encrypt payload, AES-GCM).
  encrypted INTEGER DEFAULT 0,
  -- Live chat opt-in (1 = chat enabled; messages flow via the ChatRoom Durable Object).
  chat_enabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_streams_stream_id ON streams(stream_id);
CREATE INDEX IF NOT EXISTS idx_streams_user_id ON streams(user_id);

-- Broadcaster allow list (default-deny): a user may broadcast ONLY if there is a
-- row here for their email with status='allowed'. No row, or status='suspended',
-- means broadcasting is blocked. Managed from the /cleardata admin page.
CREATE TABLE IF NOT EXISTS broadcaster_access (
  email TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'allowed', -- 'allowed' | 'suspended'
  note TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Seed the site owner so default-deny never locks them out.
INSERT OR IGNORE INTO broadcaster_access (email, status) VALUES ('erik@vivoh.com', 'allowed');
