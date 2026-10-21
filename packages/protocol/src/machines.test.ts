import { describe, expect, it } from "vitest";
import { CreateNibblet } from "./schema.ts";
import { maskProductKey, WindowsProductKey } from "./machines.ts";

describe("a Windows product key", () => {
  it("is taken as it's often typed: lower case, with spaces around it", () => {
    expect(WindowsProductKey.parse("  abcde-12345-fghij-67890-klmno ")).toBe(
      "ABCDE-12345-FGHIJ-67890-KLMNO",
    );
  });

  it("is five groups of five, nothing else", () => {
    for (const wrong of [
      "ABCDE-12345-FGHIJ-67890",
      "ABCDE12345FGHIJ67890KLMNO",
      "ABCDE-12345-FGHIJ-67890-KLMN!",
    ]) {
      expect(WindowsProductKey.safeParse(wrong).success).toBe(false);
    }
  });

  it("is shown with only its last group, as Windows shows one", () => {
    expect(maskProductKey("ABCDE-12345-FGHIJ-67890-KLMNO")).toBe("•••••-•••••-•••••-•••••-KLMNO");
  });

  it("is optional when a nibblet's made", () => {
    const base: CreateNibblet = { name: "Pip", harness: "claude", model: "m", effort: "low" };
    expect(CreateNibblet.parse(base).windowsProductKey).toBeUndefined();
    expect(() => CreateNibblet.parse({ ...base, windowsProductKey: "nope" })).toThrow();
  });
});
