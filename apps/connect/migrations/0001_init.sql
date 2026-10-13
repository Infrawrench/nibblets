-- People, keyed by their Clerk user id.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Linked servers. The secret a server authenticates with is stored hashed.
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  platform TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  version TEXT,
  nibblets INTEGER NOT NULL DEFAULT 0,
  routes TEXT NOT NULL DEFAULT '{"lan":[],"tailscale":null,"tunnel":null}',
  last_seen_at TEXT,
  linked_at TEXT NOT NULL,
  -- A managed Cloudflare Tunnel and its DNS record, when the service made them.
  tunnel_id TEXT,
  dns_record_id TEXT
);
CREATE INDEX servers_user ON servers (user_id);

-- Codes a server is waiting on someone to approve. Approved rows hold the
-- server's credentials until it collects them, then are deleted.
CREATE TABLE link_requests (
  code TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT,
  server_id TEXT,
  server_secret TEXT,
  tunnel TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
