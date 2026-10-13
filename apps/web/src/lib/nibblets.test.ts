import { describe, expect, it } from "vitest";
import {
  HamsterLook,
  defaultHamsterLook,
  randomHamsterLook,
  type Nibblet,
} from "@nibblet/protocol";
import { orderNibblets } from "./nibblets.ts";
import { optionLabel, withField } from "../components/hamster/HamsterEditor.tsx";
import { bellyFill, markingFill } from "../components/hamster/palette.ts";

const nibblet = (id: string, parentId: string | null, active: string): Nibblet => ({
  id,
  name: id,
  look: defaultHamsterLook,
  harness: "claude",
  model: "claude-opus-5-5",
  effort: "medium",
  instructions: "",
  parentId,
  status: "idle",
  statusDetail: null,
  heartbeat: { enabled: false, everyMinutes: 30, activeHours: null, prompt: null },
  browser: false,
  hostTools: [],
  cliCredentials: [],
  mcpServers: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  lastActivityAt: active,
});

describe("orderNibblets", () => {
  it("puts each sub-agent under its parent, most recent first", () => {
    const order = orderNibblets([
      nibblet("old", null, "2026-10-01T00:00:00.000Z"),
      nibblet("child", "new", "2026-10-03T00:00:00.000Z"),
      nibblet("new", null, "2026-10-02T00:00:00.000Z"),
      nibblet("orphan", "gone", "2026-09-01T00:00:00.000Z"),
    ]);
    expect(order.map((o) => `${o.nibblet.id}:${o.depth}`)).toEqual([
      "new:0",
      "child:1",
      "old:0",
      "orphan:0",
    ]);
  });
});

describe("hamster looks", () => {
  it("randomises only to valid looks", () => {
    let seed = 0;
    const random = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < 200; i++)
      expect(HamsterLook.safeParse(randomHamsterLook(random)).success).toBe(true);
  });

  it("changes one field at a time", () => {
    const look = withField(defaultHamsterLook, "accessory", "crown");
    expect(look).toEqual({ ...defaultHamsterLook, accessory: "crown" });
    expect(defaultHamsterLook.accessory).toBe("none");
  });

  it("labels options for people", () => {
    expect(optionLabel("party_hat")).toBe("Party hat");
  });

  it("uses light markings on dark fur", () => {
    const dark = { ...defaultHamsterLook, fur: "black" as const, belly: "white" as const };
    expect(markingFill(dark)).toBe(bellyFill(dark));
  });
});
