-- Third parties: other companies' agents (Revnu, say) a person connects to
-- their account, shown in the sidebar beside their nibblets. Each holds the
-- credential the third party gave, sealed with THIRD_PARTY_KEY (AES-GCM,
-- bound to the row's id), since Connect has to use it rather than check it.
CREATE TABLE third_parties (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plugin TEXT NOT NULL,
  -- The third party's own id for the account, so connecting it again replaces this.
  ref TEXT NOT NULL,
  account TEXT NOT NULL,
  credential TEXT NOT NULL,
  abilities TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'live',
  connected_at TEXT NOT NULL
);
CREATE UNIQUE INDEX third_parties_account ON third_parties (user_id, plugin, ref);

-- The client Connect registered with each third party's sign-in, per
-- address it comes back to.
CREATE TABLE third_party_clients (
  plugin TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  client_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (plugin, redirect_uri)
);

-- Sign-ins in progress, by a hash of the state they come back with. The
-- PKCE verifier is only ever used to finish this one. The callback keeps the
-- code here; the person who started it, signed in, finishes it.
CREATE TABLE third_party_sign_ins (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plugin TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  verifier TEXT NOT NULL,
  code TEXT,
  expires_at TEXT NOT NULL
);
