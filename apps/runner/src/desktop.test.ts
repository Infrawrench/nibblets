import { describe, expect, it } from "vitest";
import { desktopEnv } from "./desktop.ts";

describe("the desktop's environment", () => {
  it("keeps the runner's own variables from the apps, and gives them a UTF-8 locale", () => {
    expect(
      desktopEnv({ PATH: "/usr/bin", NIBBLET_TOKEN: "secret", NIBBLET_CREDPROXY_KEY: "key" }),
    ).toEqual({ PATH: "/usr/bin", LANG: "C.UTF-8" });
    expect(desktopEnv({ LANG: "en_GB.UTF-8" }).LANG).toBe("en_GB.UTF-8");
  });
});
