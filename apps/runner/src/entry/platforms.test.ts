import { describe, expect, it } from "vitest";
import { userCommands, USERS } from "../machine/macos-desktop.ts";
import { emptyHome, onlyFenced, pfRules, SUDOERS_RULES, VOLUME_FOLDERS } from "./macos.ts";
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
  const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

  it("are the guard's, and SYSTEM's and Administrators', alone", () => {
    expect(aclArgs("C:\\Users\\nibblet\\.guard", "guard", SID)).toEqual([
      "C:\\Users\\nibblet\\.guard",
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
      "/Q",
    ]);
  });

  it("let the agent only read the browser's downloads", () => {
    expect(aclArgs("D", "downloads", SID)).toContain(`*${SID}:(OI)(CI)RX`);
    expect(aclArgs("D", "agent", SID)).toContain(`*${SID}:(OI)(CI)M`);
  });

  it("name the agent's user by its SID, never a name the computer may share", () => {
    expect(aclArgs("D", "agent", SID).join(" ")).not.toMatch(/\bnibblet:/);
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

describe("macOS's tailnet fence", () => {
  const rules = pfRules(null, null, { uid: 1200, ports: [3000] }).split("\n");

  it("lets Tailscale's user reach only the shared ports on loopback", () => {
    expect(rules).toContain(
      "pass out quick on lo0 proto { tcp udp } to any port 3000 user 1200 keep state",
    );
    expect(rules.at(-2)).toBe("block return out quick on lo0 proto { tcp udp } all user 1200");
  });

  it("keeps state for everyone else's, so tailscaled's replies to the agent get through", () => {
    expect(
      rules.indexOf("pass out quick on lo0 proto { tcp udp } all user != 1200 keep state"),
    ).toBe(1);
  });

  it("isn't there for a nibblet off the tailnet", () => {
    expect(pfRules(null, null)).not.toContain("lo0");
  });
});

describe("macOS's users", () => {
  it("are hidden, with no password to begin with, and the uids the entry starts them as", () => {
    const [agent] = USERS;
    if (!agent) throw new Error("no agent user");
    const commands = userCommands(agent);
    expect(commands).toContainEqual(["-create", "/Users/nibblet", "UniqueID", "1001"]);
    expect(commands).toContainEqual(["-create", "/Users/nibblet", "IsHidden", "1"]);
    expect(commands).toContainEqual(["-create", "/Users/nibblet", "Password", "*"]);
    // macOS gives one itself, and turns down setting it.
    expect(commands.some((c) => c.includes("GeneratedUID"))).toBe(false);
  });

  it("include Tailscale's own, with its uid", () => {
    expect(USERS.map((u) => [u.name, u.uid])).toContainEqual(["_nibblettailscale", 1200]);
  });
});

describe("macOS's desktop", () => {
  it("lets the guard run only the session script as root, with only its tokens", () => {
    expect(SUDOERS_RULES).toContain(
      "_nibbletguard ALL = (root) NOPASSWD: /Library/Nibblets/bin/nibblet-session",
    );
    expect(SUDOERS_RULES).toContain('env_keep += "OCU_SERVE_TOKEN OCU_VIEW_TOKEN"');
    expect(SUDOERS_RULES).not.toContain("SETENV");
  });
});

describe("macOS's home volume", () => {
  it("is emptied for a restore around the volume's own folders, which root can't always touch", () => {
    const command = emptyHome();
    for (const folder of VOLUME_FOLDERS) expect(command).toContain(`! -name '${folder}'`);
    expect(command).toContain("-maxdepth 1");
  });
});

describe("macOS's home archive", () => {
  const fenced = "tar: Can't open `26A434-galvatron.bnnsir': Operation not permitted";

  it("does without files macOS won't let root read or change", () => {
    expect(
      onlyFenced([
        fenced,
        "tar: nibblet/Library/ContainerManager: Couldn't visit directory: Operation not permitted",
        "tar: nibblet/Library/Group Containers: Can't set permissions: Operation not permitted",
        "tar: nibblet/Library/Containers/com.apple.printcenter.PrintCenterWidget/Data: Couldn't visit directory: Interrupted system call",
        "tar: Error exit delayed from previous errors.",
        "",
      ]),
    ).toBe(true);
  });

  it("fails for anything else tar says", () => {
    expect(onlyFenced([fenced, "tar: Write error"])).toBe(false);
    expect(onlyFenced(["tar: Error exit delayed from previous errors."])).toBe(false);
    expect(onlyFenced(["tar: nibblet/x: Can't open: No such file or directory"])).toBe(false);
  });
});
