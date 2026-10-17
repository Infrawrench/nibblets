import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Docker from "dockerode";
import { DockerMachines } from "../src/index.ts";

/** Needs Docker and the runner image: `NIBBLET_TEST_DOCKER=1`. */
describe.skipIf(!process.env.NIBBLET_TEST_DOCKER)("home archives", () => {
  const id = `nib_test${Date.now().toString(36)}`;
  const docker = new DockerMachines({
    docker: new Docker(),
    network: "nibblet",
    runnerImage: "nibblet/runner:dev",
    hostSshAuthSock: "",
  });
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nibblet-home-"));
  });
  afterAll(async () => {
    await docker.removeHome(id);
    await rm(dir, { recursive: true, force: true });
  });

  const write = (file: string, text: string) =>
    docker.inHome(
      `nibblet-home-${id}`,
      ["sh", "-c", `mkdir -p "$(dirname ${file})" && printf %s '${text}' > ${file}`],
      { readOnly: false },
    );

  it("archives a home folder and puts it back exactly", async () => {
    await write("/home/nibblet/work/a.txt", "first");
    await write("/home/nibblet/.cache/big", "cache");
    const archive = join(dir, "a.tar.gz");
    const out = createWriteStream(archive);
    await docker.archiveHome(id, out);
    out.end();
    await finished(out);

    await write("/home/nibblet/work/a.txt", "second");
    await write("/home/nibblet/work/b.txt", "new");
    await docker.restoreHome(id, createReadStream(archive));

    const listing = join(dir, "listing");
    const list = createWriteStream(listing);
    await docker.inHome(
      `nibblet-home-${id}`,
      [
        "sh",
        "-c",
        "cd /home/nibblet && find work .cache -type f 2>/dev/null | sort; cat work/a.txt",
      ],
      { readOnly: true, stdout: list },
    );
    list.end();
    await finished(list);
    expect((await readFile(listing, "utf8")).trim().split("\n")).toEqual(["work/a.txt", "first"]);
  }, 60_000);
});
