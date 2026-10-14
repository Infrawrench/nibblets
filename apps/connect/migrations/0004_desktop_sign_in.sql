-- Signing the desktop app in from the person's own browser, where Google and
-- the like will let them. A browser signed in to Clerk leaves a one-off Clerk
-- sign-in token here under a handle it sends back to the app; only the app,
-- holding the secret whose hash is the challenge, can collect it.
CREATE TABLE desktop_sign_ins (
  handle_hash TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  ticket TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
