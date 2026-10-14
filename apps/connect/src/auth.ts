import { createClerkClient, verifyToken } from "@clerk/backend";

export interface AuthEnv {
  CLERK_SECRET_KEY: string;
  DEV_AUTH_USER: string;
}

export interface SignedIn {
  id: string;
  /** For display: a name, or an email address when there's no name. */
  name: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `DEV_AUTH_USER` signs every request in as that user, for `wrangler dev`
 * without a Clerk application. It only works on a loopback host, so setting it
 * on a deployed Worker does nothing.
 */
export function devUser(env: AuthEnv, url: URL): SignedIn | null {
  if (!env.DEV_AUTH_USER || !LOCAL_HOSTS.has(url.hostname)) return null;
  return { id: env.DEV_AUTH_USER, name: `${env.DEV_AUTH_USER} (dev)` };
}

/** The person behind a Clerk session token, or null. */
export async function clerkUser(
  env: AuthEnv,
  token: string,
  knownName: (id: string) => Promise<string | null>,
): Promise<SignedIn | null> {
  if (!env.CLERK_SECRET_KEY || !token) {
    if (!token) console.warn(JSON.stringify({ message: "no session token sent" }));
    return null;
  }
  let sub: string;
  try {
    const claims = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
    sub = claims.sub;
  } catch (err) {
    // The reason only, never the token.
    console.warn(JSON.stringify({ message: "clerk session rejected", reason: String(err) }));
    return null;
  }
  const cached = await knownName(sub);
  if (cached) return { id: sub, name: cached };
  // First sight of this person: ask Clerk what to call them.
  const user = await createClerkClient({ secretKey: env.CLERK_SECRET_KEY }).users.getUser(sub);
  const full = [user.firstName, user.lastName].filter(Boolean).join(" ");
  const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
  return { id: sub, name: full || user.username || email || "You" };
}
