import { describe, expect, it } from "vitest";
import { findUrls } from "./terminal.ts";

describe("finding sign-in links in terminal output", () => {
  it("strips colours and links, and trailing punctuation", () => {
    const out =
      "\u001b[1mOpen this page:\u001b[0m \u001b]8;;https://claude.ai/oauth?code=1\u0007https://claude.ai/oauth?code=1\u001b]8;;\u0007.\r\n";
    expect(findUrls(out)).toEqual(["https://claude.ai/oauth?code=1"]);
  });

  it("waits for an address that may still be arriving", () => {
    expect(findUrls("Go to https://auth.openai.com/authorize?x=")).toEqual([]);
    expect(findUrls("Go to https://auth.openai.com/authorize?x=1 now")).toEqual([
      "https://auth.openai.com/authorize?x=1",
    ]);
  });
});
