import { describe, expect, it } from "vitest";
import { pfRules, userCommands, USERS } from "./macos.ts";
import { aclArgs, rangesExcept } from "./windows.ts";

describe("Windows Firewall's ranges", () => {
  it("leaves the host out of its network", () => {
    expect(rangesExcept("172.29.16.0/20", "172.29.16.1")).toEqual([
      "172.29.16.0-172.29.16.0",
      "172.29.16.2-172.29.31.255",
    ]);
  });

  it("is the whole network when the host isn't in it", () => {
    expect(rangesExcept("10.0.2.0/24", "192.168.1.1")).toEqual(["10.0.2.0-10.0.2.255"]);
    expect(rangesExcept("10.0.2.0/24", null)).toEqual(["10.0.2.0-10.0.2.255"]);
  });

  it("has nothing to say for an address that isn't a network", () => {
    expect(rangesExcept("nonsense", null)).toEqual([]);
  });
});

describe("Windows' folders", () => {
  it("are the guard's, and SYSTEM's and Administrators', alone", () => {
    expect(aclArgs("C:\\Users\\nibblet\\.guard", "guard")).toEqual([
      "C:\\Users\\nibblet\\.guard",
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
      "/Q",
    ]);
  });

  it("let the agent only read the browser's downloads", () => {
    expect(aclArgs("D", "downloads")).toContain("nibblet:(OI)(CI)RX");
    expect(aclArgs("D", "agent")).toContain("nibblet:(OI)(CI)M");
  });
});

describe("macOS's firewall", () => {
  it("lets the host through and fences off the rest of the network", () => {
    expect(pfRules("192.168.64.0/24", "192.168.64.1").split("\n")).toEqual([
      "block drop out quick inet from any to 169.254.0.0/16",
      "pass out quick inet from any to 192.168.64.1",
      "block drop out quick inet from any to 192.168.64.0/24",
      "",
    ]);
  });

  it("still blocks cloud metadata with no network to speak of", () => {
    expect(pfRules(null, null)).toBe("block drop out quick inet from any to 169.254.0.0/16\n");
  });
});

describe("macOS's users", () => {
  it("are hidden, with no password, and the uids the entry starts them as", () => {
    const [agent] = USERS;
    if (!agent) throw new Error("no agent user");
    const commands = userCommands(agent);
    expect(commands).toContainEqual(["-create", "/Users/nibblet", "UniqueID", "1001"]);
    expect(commands).toContainEqual(["-create", "/Users/nibblet", "IsHidden", "1"]);
    expect(commands).toContainEqual(["-create", "/Users/nibblet", "Password", "*"]);
  });
});
