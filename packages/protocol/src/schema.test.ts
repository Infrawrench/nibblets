import { describe, expect, it } from "vitest";
import { HamsterLook, randomHamsterLook } from "./schema.ts";

describe("randomHamsterLook", () => {
  it("always produces a valid look", () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    for (let i = 0; i < 500; i++)
      expect(HamsterLook.safeParse(randomHamsterLook(random)).success).toBe(true);
  });
});
