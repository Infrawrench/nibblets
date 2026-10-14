import { describe, expect, it } from "vitest";
import { firewallRules, ownSubnet } from "./entry.ts";

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
});
