import { describe, expect, it } from "vitest";
import { mergeFeeds } from "./feed.ts";

const feed = (arch: string, version = "0.2.0") => `version: ${version}
files:
  - url: Nibblets-${arch}.zip
    sha512: zip-${arch}
    size: 100
  - url: Nibblets-${arch}.dmg
    sha512: dmg-${arch}
    size: 200
path: Nibblets-${arch}.zip
sha512: zip-${arch}
releaseDate: '2026-10-14T15:52:36.792Z'
`;

describe("mergeFeeds", () => {
  it("lists every architecture's files under one feed", () => {
    expect(mergeFeeds([feed("arm64"), feed("x64")])).toBe(`version: 0.2.0
files:
  - url: Nibblets-arm64.zip
    sha512: zip-arm64
    size: 100
  - url: Nibblets-arm64.dmg
    sha512: dmg-arm64
    size: 200
  - url: Nibblets-x64.zip
    sha512: zip-x64
    size: 100
  - url: Nibblets-x64.dmg
    sha512: dmg-x64
    size: 200
path: Nibblets-arm64.zip
sha512: zip-arm64
releaseDate: '2026-10-14T15:52:36.792Z'
`);
  });

  it("lists a file once", () => {
    expect(mergeFeeds([feed("arm64"), feed("arm64")]).match(/url:/g)).toHaveLength(2);
  });

  it("refuses feeds for different versions, or anything else", () => {
    expect(() => mergeFeeds([feed("arm64"), feed("x64", "0.3.0")])).toThrow(/different versions/);
    expect(() => mergeFeeds(["version: 1\n"])).toThrow(/no files/);
    expect(() => mergeFeeds([])).toThrow();
  });
});
