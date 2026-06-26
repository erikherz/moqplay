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
