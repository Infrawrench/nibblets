# Nibblets Connect

The central service, like T3 Connect: sign in, see every server you run, and
use each one from anywhere. It's a Cloudflare Worker (Hono, D1), deployed at
<https://app.nibblets.dev>. It isn't in the data path:
it hands out addresses and five-minute tokens, and the browser then talks to
each server directly.

## How it works

- **Linking.** A server asks for a code (`POST /v1/link/start`). Someone signed
  in approves it at `/link?code=…`, checking it matches the code the server
  shows. The server collects its id and secret by polling (`/v1/link/poll`),
  once.
- **Check-ins.** Linked servers send a heartbeat every 30 seconds with their
  routes (local network, Tailscale, tunnel). One that hasn't checked in for
  90 seconds shows as offline.
- **Tokens.** `POST /v1/servers/:id/token` mints an ES256 JWT (aud = server
  id, sub = Clerk user id, 5 minutes). Servers verify it against
  `/.well-known/jwks.json`.
- **Tunnels.** With `CF_ZONE_ID` and `CF_ZONE_NAME` set (and `CF_API_TOKEN`
  with Cloudflare Tunnel Edit and DNS Edit), approving a server creates a
  remotely managed tunnel and a `<server-id>.<zone>` CNAME for it, and
  removing the server deletes both. Without a zone, which is the setup today,
  servers run a quick tunnel and report its `trycloudflare.com` address,
  which changes when the tunnel restarts.
- **Sign-in.** Clerk. `DEV_AUTH_USER` signs every request in as that user,
  but only on localhost, so it's for `wrangler dev` alone.

## Deploying

Secrets, with `wrangler secret put` (pipe them in; don't paste them into
files in the repo):

| Secret                  | What                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERK_SECRET_KEY`      | The Clerk application's secret key                                                                                                       |
| `CLERK_PUBLISHABLE_KEY` | Its publishable key; the UI reads it from `/v1/config`                                                                                   |
| `JWT_PRIVATE_KEY`       | `node scripts/gen-key.mjs \| npx wrangler secret put JWT_PRIVATE_KEY`. Replacing it signs everyone out of every server until they reload |
| `CF_API_TOKEN`          | Optional: for managed tunnels                                                                                                            |

Variables in `wrangler.jsonc`: `PUBLIC_URL` (set it when adding a custom
domain, so tokens and links use it), `CF_ACCOUNT_ID`, `CF_ZONE_ID`,
`CF_ZONE_NAME`.

```sh
pnpm --filter @nibblet/connect deploy   # builds the central UI, migrates D1, deploys
```

Clerk development instances work on the workers.dev address as they are.
A production Clerk instance needs the domain it runs on (so a custom domain,
not workers.dev) set up in the Clerk dashboard.

## Developing

```sh
cp .dev.vars.example .dev.vars          # DEV_AUTH_USER=you skips Clerk
npx wrangler d1 migrations apply nibblets-connect --local
pnpm --filter @nibblet/web build:central
npx wrangler dev
```

To link a server running in Docker to it, give the server
`NIBBLET_CENTRAL_URL=http://host.docker.internal:8787` and run `wrangler dev
--var PUBLIC_URL:http://host.docker.internal:8787`.
