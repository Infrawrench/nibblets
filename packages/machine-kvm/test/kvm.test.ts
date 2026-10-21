import { describe, expect, it } from "vitest";
import { GUEST_PORT_NAME } from "@nibblets/protocol";
import { deviceArgs } from "../src/index.ts";

const disks = { system: "/vm/system.qcow2", home: "/vm/home.qcow2" };
const ports = { agent: "/tmp/agent.sock", console: "/vm/console.log" };

describe("a KVM guest's devices", () => {
  it("are virtio for Linux, with the agent's port named", () => {
    const args = deviceArgs("linux", disks, ports, "02:00:00:00:00:01").join(" ");
    expect(args).toContain(`virtserialport,chardev=agent,name=${GUEST_PORT_NAME}`);
    expect(args).toContain("file=/vm/system.qcow2,if=virtio");
    expect(args).toContain("virtio-net-pci,netdev=net0,mac=02:00:00:00:00:01");
  });

  it("are what Windows has drivers for, with the agent on COM2", () => {
    const args = deviceArgs("windows", disks, ports, "02:00:00:00:00:01").join(" ");
    expect(args).toContain("isa-serial,chardev=agent,index=1");
    expect(args).toContain("ide-hd,drive=system,bus=ahci.0,bootindex=0");
    expect(args).toContain("e1000e,netdev=net0");
    expect(args).not.toContain("if=virtio");
  });

  it("put the console on a file, for either", () => {
    for (const guest of ["linux", "windows"] as const) {
      expect(deviceArgs(guest, disks, ports, "m").join(" ")).toContain(
        "file,id=console,path=/vm/console.log",
      );
    }
  });
});
