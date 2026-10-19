import type { CardFile, ServerToRunner } from "@nibblet/protocol";
import { describe, expect, it } from "vitest";
import { CardFiles } from "./card-files.ts";

const file: CardFile = {
  id: "card_1",
  provider: "fake",
  asset: "USD",
  kind: "single_use",
  limit: "5.00",
  purpose: "x",
  details: {
    type: "card",
    pan: "4242424242424242",
    cvv: "123",
    expMonth: "01",
    expYear: "2031",
    billingAddress: null,
  },
};

function harness(connected = true) {
  const sent: { nibbletId: string; message: ServerToRunner }[] = [];
  const files = new CardFiles((nibbletId, message) => {
    if (connected) sent.push({ nibbletId, message });
    return connected;
  }, 50);
  const requestId = () => {
    const last = sent.at(-1)?.message;
    if (!last || !("requestId" in last)) throw new Error("nothing sent");
    return last.requestId;
  };
  return { files, sent, requestId };
}

describe("CardFiles", () => {
  it("sends the card and resolves with where the runner put it", async () => {
    const { files, sent, requestId } = harness();
    const put = files.put("nib_1", file);
    expect(sent[0]).toMatchObject({ nibbletId: "nib_1", message: { type: "card_put", file } });
    files.fromRunner("nib_1", {
      type: "card_done",
      requestId: requestId(),
      path: "/tmp/nibblet-cards/card_1.json",
      error: null,
    });
    await expect(put).resolves.toBe("/tmp/nibblet-cards/card_1.json");
  });

  it("ignores an answer from another nibblet's runner", async () => {
    const { files, requestId } = harness();
    const put = files.put("nib_1", file);
    files.fromRunner("nib_2", {
      type: "card_done",
      requestId: requestId(),
      path: "/x",
      error: null,
    });
    await expect(put).rejects.toThrow(/didn't answer in time/);
  });

  it("passes on the runner's error", async () => {
    const { files, requestId } = harness();
    const removing = files.remove("nib_1", "card_1");
    files.fromRunner("nib_1", {
      type: "card_done",
      requestId: requestId(),
      path: null,
      error: "EACCES",
    });
    await expect(removing).rejects.toThrow("EACCES");
  });

  it("fails at once when there's no runner, and when it goes away", async () => {
    await expect(harness(false).files.put("nib_1", file)).rejects.toThrow(/isn't running/);
    const { files } = harness();
    const put = files.put("nib_1", file);
    files.runnerGone("nib_1");
    await expect(put).rejects.toThrow(/Lost touch/);
  });
});
