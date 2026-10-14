-- Browsers (phones, mostly) that asked for notifications, per person.
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  last_sent_at TEXT
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id);
