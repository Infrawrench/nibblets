import { describe, expect, it } from "vitest";
import {
  ThirdPartySend,
  type ThirdParty,
  type ThirdPartyList,
  type ThirdPartyMessage,
} from "@nibblets/protocol";
import {
  connected,
  newClientId,
  partyStatus,
  stillOutgoing,
  type Outgoing,
} from "./thirdParties.ts";

const party = (more: Partial<ThirdParty> = {}): ThirdParty => ({
  id: "tp_1",
  plugin: "revnu",
  account: "Acme",
  state: "live",
  abilities: { chat: true, status: true, requests: true, decide: true },
  connectedAt: "2026-10-27T00:00:00.000Z",
  activity: { working: false, waiting: 0 },
  problem: null,
  ...more,
});

describe("partyStatus", () => {
  it("puts what's waiting on the person first, then working", () => {
    expect(partyStatus(party({ activity: { working: true, waiting: 3 } }))).toEqual({
      text: "3 to review",
      tone: "warning",
    });
    expect(partyStatus(party({ activity: { working: true, waiting: 0 } }))).toEqual({
      text: "Working",
      tone: "working",
    });
    expect(partyStatus(party())).toBeNull();
  });

  it("says when it needs connecting again, or isn't answering", () => {
    expect(partyStatus(party({ state: "revoked", activity: null }))?.text).toBe("Reconnect");
    expect(partyStatus(party({ activity: null, problem: "Revnu isn't answering." }))?.text).toBe(
      "Not answering",
    );
  });
});

describe("connected", () => {
  it("pairs each third party with its kind, leaving out one Connect no longer offers", () => {
    const list: ThirdPartyList = {
      enabled: true,
      kinds: [
        { id: "revnu", name: "Revnu", description: "", icon: "data:,", signIn: true, token: null },
      ],
      parties: [party(), party({ id: "tp_2", plugin: "gone" })],
    };
    expect(connected(list).map((c) => [c.party.id, c.kind.name])).toEqual([["tp_1", "Revnu"]]);
    expect(connected(undefined)).toEqual([]);
  });
});

describe("stillOutgoing", () => {
  const sentAt = Date.parse("2026-10-27T10:00:00.000Z");
  const outgoing: Outgoing = { clientId: "web-1", text: "Find UK fintechs", sentAt, failed: null };
  const message = (
    text: string,
    at: string,
    role: "person" | "agent" = "person",
  ): ThirdPartyMessage => ({
    id: `${text}-${at}`,
    role,
    text,
    at,
  });

  it("drops a message once the conversation has it", () => {
    expect(stillOutgoing([outgoing], [])).toEqual([outgoing]);
    expect(
      stillOutgoing([outgoing], [message("Find UK fintechs", "2026-10-27T10:00:02.000Z")]),
    ).toEqual([]);
  });

  it("doesn't take an older message with the same words, or the agent's, for it", () => {
    const older = message("Find UK fintechs", "2026-10-26T10:00:00.000Z");
    const echoed = message("Find UK fintechs", "2026-10-27T10:00:05.000Z", "agent");
    expect(stillOutgoing([outgoing], [older, echoed])).toEqual([outgoing]);
  });

  it("keeps one that failed, to say so", () => {
    const failed = { ...outgoing, failed: "Revnu asked to slow down." };
    expect(
      stillOutgoing([failed], [message("Find UK fintechs", "2026-10-27T10:00:02.000Z")]),
    ).toEqual([failed]);
  });
});

it("makes client ids Connect takes", () => {
  expect(ThirdPartySend.safeParse({ text: "hi", clientId: newClientId() }).success).toBe(true);
});
