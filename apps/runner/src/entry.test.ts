import { describe, expect, it } from "vitest";
import {
  firewallRules,
  nameservers,
  ownSubnet,
  safeId,
  tailnetPorts,
  tailnetRules,
} from "./entry.ts";

describe("a sub-agent's id", () => {
  it("is taken as the server makes them", () => {
    expect(safeId("nb_TtoJSyhCSr21")).toBe("nb_TtoJSyhCSr21");
  });

  it("can't reach out of the folders it names", () => {
    for (const id of ["../guard", "nb/x", "", undefined, "nb x"]) {
      expect(() => safeId(id)).toThrow();
    }
  });
});

describe("the container's firewall", () => {
  it("finds the network the container is on", () => {
    expect(
      ownSubnet({
        lo: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "",
            internal: true,
            cidr: "127.0.0.1/8",
          },
        ],
        eth0: [
          {
            address: "10.89.1.7",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "",
            internal: false,
            cidr: "10.89.1.7/24",
          },
        ],
      }),
    ).toBe("10.89.1.0/24");
    expect(ownSubnet({})).toBeNull();
  });

  it("blocks cloud metadata, and the rest of the network but the server and proxy", () => {
    expect(firewallRules("10.89.1.0/24", ["10.89.1.2", "10.89.1.3"])).toEqual([
      ["-A", "OUTPUT", "-d", "169.254.0.0/16", "-j", "REJECT"],
      ["-A", "OUTPUT", "-d", "10.89.1.2", "-j", "ACCEPT"],
      ["-A", "OUTPUT", "-d", "10.89.1.3", "-j", "ACCEPT"],
      ["-A", "OUTPUT", "-d", "10.89.1.0/24", "-j", "REJECT"],
    ]);
  });

  it("lets DNS through to the nameservers, which Podman puts on the gateway", () => {
    expect(firewallRules("10.89.1.0/24", ["10.89.1.2"], ["10.89.1.1"])).toEqual([
      ["-A", "OUTPUT", "-d", "169.254.0.0/16", "-j", "REJECT"],
      ["-A", "OUTPUT", "-d", "10.89.1.1", "-p", "udp", "--dport", "53", "-j", "ACCEPT"],
      ["-A", "OUTPUT", "-d", "10.89.1.1", "-p", "tcp", "--dport", "53", "-j", "ACCEPT"],
      ["-A", "OUTPUT", "-d", "10.89.1.2", "-j", "ACCEPT"],
      ["-A", "OUTPUT", "-d", "10.89.1.0/24", "-j", "REJECT"],
    ]);
  });

  it("reads the nameservers from resolv.conf", () => {
    const conf =
      "search dns.podman\nnameserver 10.89.1.1\n# nameserver 9.9.9.9\nnameserver ::1\noptions ndots:0\n";
    expect(nameservers(conf)).toEqual(["10.89.1.1"]);
    expect(nameservers("nameserver 127.0.0.11\noptions ndots:0")).toEqual(["127.0.0.11"]);
  });
});

describe("the tailnet's firewall", () => {
  const mine = ["-A", "OUTPUT", "-o", "lo", "-m", "owner", "--uid-owner", "1200"];
  // Its proxy's replies to the agent go out on loopback as Tailscale's user too.
  const replies = [...mine, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"];

  it("lets Tailscale's user reach the shared ports and the nameservers on loopback, and nothing else", () => {
    expect(tailnetRules(1200, [3000], ["127.0.0.11"])).toEqual([
      replies,
      [...mine, "-d", "127.0.0.11", "-j", "ACCEPT"],
      [...mine, "-p", "tcp", "--dport", "3000", "-j", "ACCEPT"],
      [...mine, "-p", "udp", "--dport", "3000", "-j", "ACCEPT"],
      [...mine, "-j", "REJECT"],
    ]);
  });

  it("shuts everything off when nothing is shared", () => {
    expect(tailnetRules(1200, [])).toEqual([replies, [...mine, "-j", "REJECT"]]);
  });

  it("takes only ports a user could have shared", () => {
    expect(tailnetPorts("3000, 8080")).toEqual([3000, 8080]);
    // The gate, the browser, its view, the desktop's two, the proxy, sub-agents' ports, and junk.
    expect(tailnetPorts("7810,7800,7900,7801,7901,1055,25000,0,abc,")).toEqual([]);
    expect(tailnetPorts(undefined)).toEqual([]);
  });
});
