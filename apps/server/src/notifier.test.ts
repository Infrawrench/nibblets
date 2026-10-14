import { describe, expect, it } from "vitest";
import type { PushNote } from "@nibblet/protocol";
import { Notifier, type Watched } from "./notifier.ts";

const nibblet = (patch: Partial<Watched>): Watched => ({
  id: "nib_1",
  name: "Crumpet",
  status: "idle",
  awaitingApproval: false,
  statusText: null,
  statusDetail: null,
  ...patch,
});

describe("push notes for a nibblet that needs its person", () => {
  it("fires once as an approval or error starts, never for how things already were", () => {
    const sent: PushNote[] = [];
    const notifier = new Notifier((n) => sent.push(n));
    // Already waiting when the server started: not news.
    notifier.changed(nibblet({ awaitingApproval: true }));
    notifier.changed(nibblet({ awaitingApproval: true }));
    expect(sent).toEqual([]);

    notifier.changed(nibblet({ awaitingApproval: false }));
    notifier.changed(nibblet({ awaitingApproval: true, statusText: "Paying the gas bill" }));
    notifier.changed(nibblet({ awaitingApproval: true, status: "working" }));
    notifier.changed(nibblet({ status: "error", statusDetail: "Container stopped" }));
    notifier.changed(nibblet({ status: "error", statusDetail: "Container stopped" }));

    expect(sent).toEqual([
      {
        nibbletId: "nib_1",
        title: "Crumpet needs your OK",
        body: "Paying the gas bill",
        tag: "approval-nib_1",
      },
      {
        nibbletId: "nib_1",
        title: "Crumpet needs help",
        body: "Container stopped",
        tag: "error-nib_1",
      },
    ]);
  });
});
