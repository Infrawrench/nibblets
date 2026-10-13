import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { readClaudeKeychain, writeClaudeKeychain } from "./credentials.ts";

export const BRIDGE_PORT = 8788;

/**
 * Lets the credential proxy, inside Docker, read and update Claude Code's
 * keychain item, which only a process on the host can open. Bound to
 * loopback; Docker Desktop and OrbStack forward host.docker.internal there.
 * Every request needs the bridge token the proxy was started with.
 */
export function startKeychainBridge(token: string): Promise<Server> {
  const expected = Buffer.from(`Bearer ${token}`);
  const authorised = (req: IncomingMessage) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const server = createServer(async (req, res) => {
    const send = (status: number, body = "") => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    };
    if (!authorised(req)) return send(401, '{"error":"unauthorized"}');
    if (req.url !== "/anthropic")
      return send(404, '{"error":"only the Claude login lives in the keychain"}');
    try {
      if (req.method === "GET") {
        const text = await readClaudeKeychain();
        return text ? send(200, text) : send(404, '{"error":"Claude Code is not signed in"}');
      }
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const chunk of req)
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString("utf8");
        JSON.parse(text);
        await writeClaudeKeychain(text);
        return send(204);
      }
      return send(405);
    } catch (err) {
      return send(500, JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(BRIDGE_PORT, "127.0.0.1", () => resolve(server));
  });
}
