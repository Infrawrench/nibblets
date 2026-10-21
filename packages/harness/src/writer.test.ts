import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadItem } from "@nibblets/protocol";
import { sentenceEnd, TurnWriter } from "./index.ts";

describe("sentenceEnd", () => {
  it("finds the end of the last whole sentence or line", () => {
    expect(sentenceEnd("Hello there. How are")).toBe("Hello there. ".length);
    expect(sentenceEnd('She said "hi." Then')).toBe('She said "hi." '.length);
    expect(sentenceEnd("- one\n- tw")).toBe("- one\n".length);
    expect(sentenceEnd("Version 3.5 is")).toBe(0);
    expect(sentenceEnd("Nothing yet")).toBe(0);
  });
});

describe("TurnWriter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const texts = (items: ThreadItem[]) =>
    items.flatMap((i) => (i.type === "assistant_message" ? [i.text] : []));

  it("shows a reply a sentence at a time, then all of it when it's done", () => {
    const items: ThreadItem[] = [];
    const w = new TurnWriter("turn_1", (i) => items.push(i), 80, 2000);
    for (const token of ["Hel", "lo the", "re. How ", "are you"]) {
      w.delta("m1", "assistant_message", token);
      vi.advanceTimersByTime(100);
    }
    expect(texts(items)).toEqual(["Hello there. "]);
    w.delta("m1", "assistant_message", "? Fine");
    vi.advanceTimersByTime(100);
    expect(texts(items)).toEqual(["Hello there. ", "Hello there. How are you? "]);
    w.done("m1");
    expect(texts(items).at(-1)).toBe("Hello there. How are you? Fine");
  });

  it("shows text with no sentence end once it's been held a while", () => {
    const items: ThreadItem[] = [];
    const w = new TurnWriter("turn_1", (i) => items.push(i), 80, 2000);
    w.delta("m1", "assistant_message", "const answer = compute(");
    vi.advanceTimersByTime(1000);
    expect(texts(items)).toEqual([]);
    vi.advanceTimersByTime(1100);
    expect(texts(items)).toEqual(["const answer = compute("]);
  });
});
