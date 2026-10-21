import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectHvSock } from "../src/hvsock.ts";

describe("a Hyper-V socket through the helper", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  /** A stand-in for the helper: a script saying `lines` on stderr, then doing `then`. */
  async function helper(lines: string[], then: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "nibblet-hvsock-"));
    const file = join(dir, "helper.sh");
    const say = lines.map((l) => `echo '${l}' >&2`).join("\n");
    await writeFile(file, `#!/bin/sh\n${say}\n${then}\n`);
    await chmod(file, 0o755);
    return file;
  }

  it("isn't connected when the reason it couldn't be says 'connected'", async () => {
    // Windows' own words for a connection that timed out.
    const timedOut =
      "nibblet-hvsock: A connection attempt failed because the connected party did not properly respond after a period of time";
    const file = await helper([timedOut], "exit 1");
    await expect(connectHvSock(file, "vm", "service")).rejects.toThrow("did not properly respond");
  });

  it("is connected when it says so, and says why when it ends", async () => {
    const file = await helper(
      ["nibblet-hvsock: connected"],
      "sleep 0.2; echo 'nibblet-hvsock: the guest closed it' >&2",
    );
    const stream = await connectHvSock(file, "vm", "service");
    const ended = await new Promise<Error | undefined>((resolve) => {
      stream.once("error", resolve);
      stream.once("close", () => resolve(undefined));
    });
    expect(ended?.message).toBe("nibblet-hvsock: the guest closed it");
  });
});
