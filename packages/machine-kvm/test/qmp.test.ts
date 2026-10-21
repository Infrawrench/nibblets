import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ask } from "../src/qmp.ts";

/** A QEMU's control socket, as far as QMP goes: it greets, shakes hands, then answers `answers`. */
function pretendQemu(answers: Record<string, object>): Promise<{ path: string; server: Server }> {
  const path = join(tmpdir(), `qmp-${randomBytes(4).toString("hex")}.sock`);
  const server = createServer((socket) => {
    const say = (line: object) => socket.write(`${JSON.stringify(line)}\r\n`);
    say({ QMP: { version: { qemu: { major: 8, minor: 2, micro: 2 } }, capabilities: [] } });
    let buffered = "";
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      // QEMU takes JSON objects back to back, without lines between them.
      for (const match of buffered.matchAll(/\{"execute":"([\w-]+)"\}/g)) {
        const command = match[1] ?? "";
        if (command === "qmp_capabilities") {
          say({ return: {} });
          // An event can come at any time, and isn't an answer.
          say({
            event: "NIC_RX_FILTER_CHANGED",
            data: {},
            timestamp: { seconds: 1, microseconds: 0 },
          });
        } else {
          say(answers[command] ?? { error: { class: "CommandNotFound", desc: `no ${command}` } });
        }
      }
      buffered = "";
    });
  });
  return new Promise((resolve) => server.listen(path, () => resolve({ path, server })));
}

const Status = z.object({ running: z.boolean(), status: z.string() });

describe("asking QEMU", () => {
  let server: Server | null = null;
  afterEach(() => server?.close());

  it("has its answer after the handshake, past any events", async () => {
    const qemu = await pretendQemu({
      "query-status": { return: { running: true, singlestep: false, status: "running" } },
    });
    server = qemu.server;
    expect(await ask(qemu.path, "query-status", Status)).toEqual({
      running: true,
      status: "running",
    });
  });

  it("says QEMU's error", async () => {
    const qemu = await pretendQemu({});
    server = qemu.server;
    await expect(ask(qemu.path, "query-status", Status)).rejects.toThrow("no query-status");
  });

  it("refuses an answer that isn't what was expected", async () => {
    const qemu = await pretendQemu({ "query-status": { return: { status: "prelaunch" } } });
    server = qemu.server;
    await expect(ask(qemu.path, "query-status", Status)).rejects.toThrow();
  });
});
