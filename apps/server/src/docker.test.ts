import { describe, expect, it } from "vitest";
import { currentImages, staleImages } from "./docker.ts";
import { TUNNEL_IMAGE } from "./tunnel.ts";

describe("staleImages", () => {
  const current = currentImages("ghcr.io/infrawrench/nibblets-runner:0.1.11")!;
  const image = (Id: string, RepoTags: string[], Created = 100, Labels = {}) => ({
    Id,
    RepoTags,
    Created,
    Labels,
  });

  it("keeps this release's images and removes earlier ones", () => {
    const images = [
      image("a", ["ghcr.io/infrawrench/nibblets-runner:0.1.11"], 200),
      image("b", ["ghcr.io/infrawrench/nibblets-server:0.1.11"]),
      image("c", ["ghcr.io/infrawrench/nibblets-runner:0.1.10"]),
      image("d", ["ghcr.io/infrawrench/nibblets-credproxy:0.1.10"]),
      image("e", ["nibblet/server:dev"]),
    ];
    expect(staleImages(images, current, 200)).toEqual([
      "ghcr.io/infrawrench/nibblets-runner:0.1.10",
      "ghcr.io/infrawrench/nibblets-credproxy:0.1.10",
      "nibblet/server:dev",
    ]);
  });

  it("removes old cloudflared versions but not the one in use", () => {
    const images = [image("a", [TUNNEL_IMAGE]), image("b", ["cloudflare/cloudflared:2025.1.0"])];
    expect(staleImages(images, current, 200)).toEqual(["cloudflare/cloudflared:2025.1.0"]);
  });

  it("removes untagged builds only when they're ours", () => {
    const images = [
      image("ours", ["<none>:<none>"], 100, { "nibblet.image": "runner" }),
      image("theirs", []),
    ];
    expect(staleImages(images, current, 200)).toEqual(["ours"]);
  });

  it("leaves everything else alone", () => {
    const images = [
      image("a", ["postgres:17", "nibblet/something:1"]),
      image("b", ["ghcr.io/someone/nibblets-runner:1"]),
    ];
    expect(staleImages(images, current, 200)).toEqual([]);
  });

  it("leaves images newer than the current runner, such as an update being pulled", () => {
    const images = [image("a", ["ghcr.io/infrawrench/nibblets-runner:0.1.12"], 300)];
    expect(staleImages(images, current, 200)).toEqual([]);
  });

  it("removes local builds newer than the current runner, left from before a release was installed", () => {
    const images = [
      image("a", ["nibblet/runner:dev"], 300),
      image("b", ["<none>:<none>"], 300, { "nibblet.image": "server" }),
    ];
    expect(staleImages(images, current, 200)).toEqual(["nibblet/runner:dev", "b"]);
  });

  it("does nothing for a runner image named some other way", () => {
    expect(currentImages("example.com/custom:latest")).toBeNull();
  });
});
