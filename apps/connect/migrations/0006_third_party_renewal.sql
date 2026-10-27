-- Third parties whose tokens run out (Notra's last minutes): the refresh
-- token signing in gave, sealed like the credential but bound to
-- `<id>:refresh`, the client it belongs to, and when the credential runs
-- out. All null for a token that doesn't, or one the person pasted.
-- `renewing_until` claims renewing it for one request at a time, since a
-- refresh token can only be used once.
ALTER TABLE third_parties ADD COLUMN refresh TEXT;
ALTER TABLE third_parties ADD COLUMN client_id TEXT;
ALTER TABLE third_parties ADD COLUMN expires_at TEXT;
ALTER TABLE third_parties ADD COLUMN renewing_until TEXT;
