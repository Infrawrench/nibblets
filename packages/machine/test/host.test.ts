import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_PS1,
  INSTALL_DONE,
  INSTALL_SAYS,
  installSaid,
  isoName,
  makeIso,
  SETUP_LABEL,
  SETUP_PS1,
  windowsSetupFiles,
} from "../src/host/index.ts";

/** Reads an image back the way a reader would: the descriptor, the root directory, a file. */
function readIso(image: Uint8Array) {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const pvd = 16 * 2048;
  const label = new TextDecoder().decode(image.subarray(pvd + 40, pvd + 72)).trim();
  const rootAt = view.getUint32(pvd + 156 + 2, true);
  const files = new Map<string, Uint8Array>();
  let at = rootAt * 2048;
  for (;;) {
    const length = image[at] ?? 0;
    if (length === 0) break;
    const nameLength = image[at + 32] ?? 0;
    const name = new TextDecoder().decode(image.subarray(at + 33, at + 33 + nameLength));
    const extent = view.getUint32(at + 2, true);
    const size = view.getUint32(at + 10, true);
    if ((image[at + 25] ?? 0) === 0)
      files.set(name, image.subarray(extent * 2048, extent * 2048 + size));
    at += length;
  }
  return {
    magic: new TextDecoder().decode(image.subarray(pvd + 1, pvd + 6)),
    terminator: image[17 * 2048],
    sectors: view.getUint32(pvd + 80, true),
    label,
    files,
  };
}

describe("an ISO image", () => {
  it("has its label, and each file back as it went in", () => {
    const big = new Uint8Array(5000).map((_, i) => i % 251);
    const image = makeIso("NIBBLETSETUP", [
      { name: "b.txt", data: new TextEncoder().encode("bee") },
      { name: "a.bin", data: big },
      { name: "empty", data: new Uint8Array(0) },
    ]);
    const read = readIso(image);
    expect(read.magic).toBe("CD001");
    expect(read.terminator).toBe(255);
    expect(read.sectors * 2048).toBe(image.byteLength);
    expect(read.label).toBe("NIBBLETSETUP");
    expect([...read.files.keys()]).toEqual([isoName("a.bin"), isoName("b.txt"), isoName("empty")]);
    expect(read.files.get(isoName("a.bin"))).toEqual(big);
    expect(new TextDecoder().decode(read.files.get(isoName("b.txt")))).toBe("bee");
  });
});

describe("Windows' setup disc", () => {
  const files = windowsSetupFiles({ repo: "Infrawrench/nibblets", ref: "v0.4.0", arch: "amd64" });
  const text = (name: string) =>
    new TextDecoder().decode(files.find((f) => f.name === name)?.data ?? new Uint8Array());

  it("has the answers, and what they put on C:", () => {
    expect(files.map((f) => f.name).sort()).toEqual([
      "AUTOUNATTEND.XML",
      "BOOTSTRAP.PS1",
      "INSTALL.JSON",
      "SETUP.PS1",
    ]);
    expect(JSON.parse(text("INSTALL.JSON"))).toEqual({
      repo: "Infrawrench/nibblets",
      ref: "v0.4.0",
    });
  });

  it("finds itself by its label, and runs setup at specialize", () => {
    const xml = text("AUTOUNATTEND.XML");
    expect(xml).toContain(`-FileSystemLabel ${SETUP_LABEL}`);
    expect(xml).toMatch(/<settings pass="specialize">[\s\S]*SETUP\.PS1/);
    expect(xml).toContain('processorArchitecture="amd64"');
  });

  it("gives every Windows it makes a different administrator's password", () => {
    const again = windowsSetupFiles({ repo: "r/r", ref: "main", arch: "amd64" });
    const password = (x: string) => /<Value>([^<]+)<\/Value><PlainText>/.exec(x)?.[1];
    const first = password(text("AUTOUNATTEND.XML"));
    const second = password(new TextDecoder().decode(again[0]?.data));
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });
});

describe("what Windows says while its image is made", () => {
  it("is the last line it said on COM1, among whatever else is there", () => {
    const recorded = `${INSTALL_SAYS}Installing Node.js\r\n\u0000noise\r\n${INSTALL_SAYS}Building its helpers\r\n`;
    expect(installSaid(recorded)).toBe("Building its helpers");
    expect(installSaid("")).toBeNull();
  });

  it("says each step, and that it's done, from setup and the bootstrap", () => {
    expect(SETUP_PS1).toContain("Say 'Setting up its bootstrap'");
    expect(BOOTSTRAP_PS1).toContain(`Say '${INSTALL_DONE}'`);
    // Before it shuts down, so a hypervisor hears it.
    expect(BOOTSTRAP_PS1.indexOf(INSTALL_DONE)).toBeLessThan(
      BOOTSTRAP_PS1.indexOf("Stop-Computer"),
    );
  });
});
