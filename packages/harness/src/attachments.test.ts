import { describe, expect, it } from "vitest";
import { inputWithAttachments, isModelImage } from "./index.ts";

describe("attachments", () => {
  it("names every attached file and where it is", () => {
    const text = inputWithAttachments("What's this?", [
      { path: "/w/uploads/cat.png", name: "cat.png", mime: "image/png", size: 10 },
    ]);
    expect(text).toContain("What's this?");
    expect(text).toContain("cat.png (image/png, 10 bytes): /w/uploads/cat.png");
    expect(inputWithAttachments("hi")).toBe("hi");
  });

  it("knows which images a model can see", () => {
    expect(isModelImage("image/png")).toBe(true);
    expect(isModelImage("image/svg+xml")).toBe(false);
    expect(isModelImage("application/pdf")).toBe(false);
  });
});
